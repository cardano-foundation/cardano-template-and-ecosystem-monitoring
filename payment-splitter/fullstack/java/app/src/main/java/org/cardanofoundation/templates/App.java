package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.List;

import org.cardanofoundation.templates.validator.PaymentSplitterValidator;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * Splits whatever it holds equally between a fixed set of payees.
 *
 * <p>Anyone may trigger the split, because the rules leave the caller nothing to gain: every
 * output must go to a payee, and every payee's share must come out equal.
 *
 * <p>The subtlety is the fee. Whoever submits pays it and receives change, so a naive count of
 * "who received what" would credit them with their own money. The contract subtracts what each
 * payee contributed — which this example exercises by making a payee the caller.
 *
 * <p>Run it against a local Yaci DevKit:
 * <pre>./gradlew run</pre>
 */
public class App {

    /** Yaci DevKit's Blockfrost-compatible API. Override when the devkit is not on :8080. */
    private static final String BACKEND_URL =
            envOrDefault("CARDANO_BACKEND_URL", "http://localhost:8080/api/v1/");

    /** The devkit's pre-funded account. */
    private static final String MNEMONIC = "test test test test test test test test test test "
            + "test test test test test test test test test test test test test sauce";

    private static final Network NETWORK = Networks.testnet();

    /** A payee who is also the caller — the case the fee correction exists for. */
    private static final Account ALICE = Account.createFromMnemonic(NETWORK, MNEMONIC);
    private static final Account BOB = new Account(NETWORK);
    private static final Account CAROL = new Account(NETWORK);
    private static final Account OUTSIDER = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    /** 9 ada, so three payees split it into exact 3 ada shares. */
    private static final BigInteger POT = BigInteger.valueOf(9_000_000);
    private static final BigInteger SHARE = BigInteger.valueOf(3_000_000);

    private static final PlutusScript SPLITTER = JulcScriptLoader.load(
            PaymentSplitterValidator.class,
            ListPlutusData.of(
                    BytesPlutusData.of(keyHash(ALICE)),
                    BytesPlutusData.of(keyHash(BOB)),
                    BytesPlutusData.of(keyHash(CAROL))));

    private static final String SPLITTER_ADDRESS =
            AddressProvider.getEntAddress(SPLITTER, NETWORK).toBech32();

    public static void main(String[] args) throws Exception {
        System.out.println("Splitter address: " + SPLITTER_ADDRESS);
        System.out.println("Alice (caller):   " + ALICE.baseAddress());

        Utxo pot = fundSplitter();
        System.out.println("Pot locked in " + pot.getTxHash());

        // Resolved before the rejection cases: isRejected() treats any exception as a refusal, so
        // a lookup that failed here would masquerade as the validator saying no.
        Utxo callerInput = callerInput(pot);

        // An uneven split is refused even though every recipient is a payee.
        require(isRejected(() -> split(pot, callerInput,
                        SHARE.add(BigInteger.valueOf(500_000)),
                        SHARE.subtract(BigInteger.valueOf(500_000)), SHARE, null)),
                "an uneven split must be rejected");
        System.out.println("Uneven split rejected as expected");

        // The closed set: a slice must not leave the group, however small.
        require(isRejected(() -> split(pot, callerInput,
                        SHARE.subtract(BigInteger.valueOf(1_000_000)),
                        SHARE, SHARE, BigInteger.valueOf(1_000_000))),
                "paying an outsider must be rejected");
        System.out.println("Payment to an outsider rejected as expected");

        TxResult split = split(pot, callerInput, SHARE, SHARE, SHARE, null);
        require(split.isSuccessful(), "the split failed: " + split);
        System.out.println("Split settled in " + split.getTxHash());

        require(spendsSplitter(split.getTxHash()),
                "the confirmed transaction must spend the splitter UTxO");
        require(received(split.getTxHash(), BOB.baseAddress(), SHARE),
                "Bob must receive exactly his share");
        require(received(split.getTxHash(), CAROL.baseAddress(), SHARE),
                "Carol must receive exactly her share");

        System.out.println("Verified: every payee got an equal share, fee-payer included");
    }

    private static Utxo fundSplitter() throws Exception {
        Tx fund = new Tx()
                .payToContract(SPLITTER_ADDRESS, Amount.lovelace(POT), PlutusData.unit())
                .from(ALICE.baseAddress());

        TxResult result = TX_BUILDER.compose(fund)
                .withSigner(SignerProviders.signerFrom(ALICE))
                .completeAndWait();
        require(result.isSuccessful(), "funding the splitter failed: " + result);
        return utxoFrom(SPLITTER_ADDRESS, result.getTxHash());
    }

    /**
     * Pays out the pot.
     *
     * <p>Everything is collected on one {@code ScriptTx}. A separate wallet {@code Tx} would
     * contribute its own change output and let cardano-client-lib pick its own inputs; here the
     * caller's contribution is explicit, so the fee comes out of her wallet rather than being
     * shaved off her share — which the contract would rightly read as an uneven split.
     */
    private static TxResult split(Utxo pot, Utxo callerInput, BigInteger toAlice,
            BigInteger toBob, BigInteger toCarol, BigInteger toOutsider) throws Exception {
        ScriptTx splitTx = new ScriptTx()
                .collectFrom(List.of(callerInput))
                .collectFrom(pot, PlutusData.unit())
                .attachSpendingValidator(SPLITTER)
                .payToAddress(ALICE.baseAddress(), Amount.lovelace(toAlice))
                .payToAddress(BOB.baseAddress(), Amount.lovelace(toBob))
                .payToAddress(CAROL.baseAddress(), Amount.lovelace(toCarol));

        if (toOutsider != null) {
            splitTx = splitTx.payToAddress(OUTSIDER.baseAddress(), Amount.lovelace(toOutsider));
        }
        splitTx = splitTx.withChangeAddress(ALICE.baseAddress());

        return TX_BUILDER.compose(splitTx)
                .feePayer(ALICE.baseAddress())
                .withSigner(SignerProviders.signerFrom(ALICE))
                .completeAndWait();
    }

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the splitter address. Checking that a UTxO merely disappeared would pass by accident
     * whenever the lookup itself failed.
     */
    private static boolean spendsSplitter(String txHash) throws Exception {
        return await(txHash, utxos -> utxos.getInputs().stream()
                .anyMatch(input -> SPLITTER_ADDRESS.equals(input.getAddress())));
    }

    /** A payee who is not the caller receives exactly their share, with no change to confuse it. */
    private static boolean received(String txHash, String address, BigInteger expected)
            throws Exception {
        return await(txHash, utxos -> utxos.getOutputs().stream()
                .filter(output -> address.equals(output.getAddress()))
                .flatMap(output -> output.getAmount().stream())
                .filter(amount -> "lovelace".equals(amount.getUnit()))
                // The backend model reports quantities as strings.
                .map(amount -> new BigInteger(amount.getQuantity()))
                .reduce(BigInteger.ZERO, BigInteger::add)
                .equals(expected));
    }

    /** Polls, because a node confirms a transaction slightly before the indexer serves it. */
    private static boolean await(String txHash, TxCheck check) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return check.test(response.getValue());
                }
            } catch (Exception notIndexedYet) {
                // fall through and retry
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    @FunctionalInterface
    private interface TxCheck {
        boolean test(com.bloxbean.cardano.client.backend.model.TxContentUtxo utxos);
    }

    /**
     * Reports whether the chain refused a transaction.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a failed
     * result. Both outcomes count as a rejection.
     */
    private static boolean isRejected(Attempt attempt) {
        try {
            return !attempt.run().isSuccessful();
        } catch (Exception rejected) {
            System.out.println("  rejected: " + shortMessage(rejected));
            return true;
        }
    }

    @FunctionalInterface
    private interface Attempt {
        TxResult run() throws Exception;
    }

    private static String shortMessage(Exception e) {
        String message = String.valueOf(e.getMessage());
        return message.length() > 110 ? message.substring(0, 110) + "…" : message;
    }

    /** A UTxO of Alice's, so she contributes to the transaction and receives change. */
    private static Utxo callerInput(Utxo pot) throws Exception {
        return UTXOS.getAll(ALICE.baseAddress()).stream()
                .filter(utxo -> !utxo.getTxHash().equals(pot.getTxHash())
                        || utxo.getOutputIndex() != pot.getOutputIndex())
                .filter(utxo -> utxo.getAmount().stream()
                        .anyMatch(amount -> "lovelace".equals(amount.getUnit())
                                && amount.getQuantity()
                                        .compareTo(BigInteger.valueOf(20_000_000)) >= 0))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no UTxO of at least 20 ada"));
    }

    private static Utxo utxoFrom(String address, String txHash) throws Exception {
        return UTXOS.getAll(address).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no UTxO created by " + txHash));
    }

    private static byte[] keyHash(Account account) {
        return account.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
    }

    /** The exit code is the result, so every check throws rather than printing a warning. */
    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }

    private static String envOrDefault(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
