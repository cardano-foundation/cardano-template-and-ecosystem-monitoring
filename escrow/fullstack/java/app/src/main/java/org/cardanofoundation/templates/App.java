package org.cardanofoundation.templates;

import java.util.Optional;

import org.cardanofoundation.templates.validator.EscrowValidator;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.Address;
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
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ListPlutusData;
import com.bloxbean.cardano.client.plutus.spec.MapPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * Two-party asset swap with no arbitrator.
 *
 * <p>The initiator locks their side, the recipient opts in by putting up theirs, and the trade
 * settles only when both sign. This example walks the whole lifecycle, and shows that neither
 * party can force settlement alone.
 *
 * <p>Run it against a local Yaci DevKit:
 * <pre>./gradlew run</pre>
 */
public class App {

    /** Yaci DevKit's Blockfrost-compatible API. Override when the devkit is not on :8080. */
    private static final String BACKEND_URL =
            envOrDefault("CARDANO_BACKEND_URL", "http://localhost:8080/api/v1/");

    /** The devkit's pre-funded account, which plays the initiator. */
    private static final String MNEMONIC = "test test test test test test test test test test "
            + "test test test test test test test test test test test test test sauce";

    private static final long INITIATOR_ADA = 10;
    private static final long RECIPIENT_ADA = 15;

    /**
     * Ada the escrow carries on top of the traded bundles, to pay for its own settlement.
     *
     * <p>Without it the settlement cannot balance: the script input would exactly equal the two
     * payouts, leaving nothing for the fee, and cardano-client-lib would take the fee out of a
     * payee's output — leaving that party short of what the datum promises them, which the
     * validator then rejects. The datum still states only the traded amounts.
     */
    private static final long FEE_BUFFER_ADA = 3;

    private static final Network NETWORK = Networks.testnet();
    private static final Account INITIATOR = Account.createFromMnemonic(NETWORK, MNEMONIC);

    /** The counterparty. Funded from the initiator below, because it has to deposit its side. */
    private static final Account RECIPIENT = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final PlutusScript SCRIPT = JulcScriptLoader.load(EscrowValidator.class);
    private static final String SCRIPT_ADDRESS =
            AddressProvider.getEntAddress(SCRIPT, NETWORK).getAddress();

    public static void main(String[] args) throws Exception {
        System.out.println("Script address: " + SCRIPT_ADDRESS);
        System.out.println("Initiator: " + INITIATOR.baseAddress());
        System.out.println("Recipient: " + RECIPIENT.baseAddress());

        fundRecipient();

        // 1. The initiator locks their side and names their terms.
        Utxo initiated = lockInitiation();

        // 2. The recipient opts in. No signature is required here — the value check is what
        //    forces whoever submits this to actually put up the recipient's side.
        Utxo active = deposit(initiated);

        // 3. Neither party can force settlement alone.
        require(isRejectedWithOneSignature(active),
                "settlement with a single signature must be rejected");
        System.out.println("Single-signature settlement rejected as expected");

        // 4. Both sign, and the bundles cross over.
        String completeTx = complete(active);
        System.out.println("Trade settled in " + completeTx);
        require(spendsScriptAddress(completeTx), "settlement must consume the script UTxO");

        // 5. The unwind path, on a fresh escrow the recipient never joined.
        Utxo abandoned = lockInitiation();
        String cancelTx = cancel(abandoned);
        System.out.println("Escrow cancelled in " + cancelTx);
        require(spendsScriptAddress(cancelTx), "the cancellation must consume the script UTxO");

        System.out.println("Verified: the swap settled only with both signatures, "
                + "and an unjoined escrow was reclaimed by its initiator");
    }

    /** The recipient starts empty, and needs its own funds to deposit its side of the trade. */
    private static void fundRecipient() throws Exception {
        TxResult result = TX_BUILDER.compose(new Tx()
                        .payToAddress(RECIPIENT.baseAddress(), Amount.ada(60))
                        .from(INITIATOR.baseAddress()))
                .feePayer(INITIATOR.baseAddress())
                .withSigner(SignerProviders.signerFrom(INITIATOR))
                .completeAndWait();
        require(result.isSuccessful(), "funding the recipient failed: " + result);
        System.out.println("Funded the recipient in " + result.getTxHash());
    }

    /** Locks the initiator's side under an {@code Initiation} datum. */
    private static Utxo lockInitiation() throws Exception {
        PlutusData datum = ConstrPlutusData.of(0,
                address(INITIATOR), lovelace(INITIATOR_ADA));

        TxResult result = TX_BUILDER.compose(new Tx()
                        .payToContract(SCRIPT_ADDRESS, Amount.ada(INITIATOR_ADA + FEE_BUFFER_ADA), datum)
                        .from(INITIATOR.baseAddress()))
                .feePayer(INITIATOR.baseAddress())
                .withSigner(SignerProviders.signerFrom(INITIATOR))
                .completeAndWait();
        require(result.isSuccessful(), "locking the initiator side failed: " + result);
        System.out.println("Initiator locked " + INITIATOR_ADA + " ADA (plus a "
                + FEE_BUFFER_ADA + " ADA settlement buffer) in " + result.getTxHash());

        return scriptUtxoFrom(result.getTxHash());
    }

    /**
     * Initiation → ActiveEscrow: spends the escrow and returns it to the script holding both
     * sides, with the recipient now named in the datum.
     */
    private static Utxo deposit(Utxo initiated) throws Exception {
        PlutusData redeemer = ConstrPlutusData.of(0,
                address(RECIPIENT), lovelace(RECIPIENT_ADA));

        PlutusData activeDatum = ConstrPlutusData.of(1,
                address(INITIATOR), lovelace(INITIATOR_ADA),
                address(RECIPIENT), lovelace(RECIPIENT_ADA));

        ScriptTx depositTx = new ScriptTx()
                .collectFrom(initiated, redeemer)
                .attachSpendingValidator(SCRIPT)
                .payToContract(SCRIPT_ADDRESS,
                        Amount.ada(INITIATOR_ADA + FEE_BUFFER_ADA + RECIPIENT_ADA), activeDatum);

        // The recipient pays, so the extra ada is drawn from their UTxOs.
        TxResult result = TX_BUILDER.compose(depositTx)
                .feePayer(RECIPIENT.baseAddress())
                .withSigner(SignerProviders.signerFrom(RECIPIENT))
                .completeAndWait();
        require(result.isSuccessful(), "the recipient deposit failed: " + result);
        System.out.println("Recipient deposited " + RECIPIENT_ADA + " ADA in " + result.getTxHash());

        return scriptUtxoFrom(result.getTxHash());
    }

    /** Settles the trade, crossing the two sides over. */
    private static String complete(Utxo active) throws Exception {
        TxResult result = settle(active, true);
        require(result.isSuccessful(), "settlement failed: " + result);
        return result.getTxHash();
    }

    /**
     * Attempts settlement with only the initiator's signature.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a
     * failed result. Both outcomes count as a rejection.
     */
    private static boolean isRejectedWithOneSignature(Utxo active) {
        try {
            return !settle(active, false).isSuccessful();
        } catch (Exception rejected) {
            System.out.println("  rejected: " + rejected.getMessage());
            return true;
        }
    }

    /** The swap: the initiator receives the recipient's side and vice versa. */
    private static TxResult settle(Utxo active, boolean recipientSigns) throws Exception {
        ScriptTx settleTx = new ScriptTx()
                .collectFrom(active, ConstrPlutusData.of(2))
                .attachSpendingValidator(SCRIPT)
                .payToAddress(INITIATOR.baseAddress(), Amount.ada(RECIPIENT_ADA))
                .payToAddress(RECIPIENT.baseAddress(), Amount.ada(INITIATOR_ADA));

        var builder = TX_BUILDER.compose(settleTx)
                .feePayer(INITIATOR.baseAddress())
                .withSigner(SignerProviders.signerFrom(INITIATOR));

        // Required signers are what put each key hash into the validator's signatory list.
        if (recipientSigns) {
            builder = builder
                    .withSigner(SignerProviders.signerFrom(RECIPIENT))
                    .withRequiredSigners(new Address(INITIATOR.baseAddress()),
                            new Address(RECIPIENT.baseAddress()));
        } else {
            builder = builder.withRequiredSigners(new Address(INITIATOR.baseAddress()));
        }
        return builder.completeAndWait();
    }

    /** Unwinds an escrow the recipient never joined; the initiator's signature alone suffices. */
    private static String cancel(Utxo initiated) throws Exception {
        ScriptTx cancelTx = new ScriptTx()
                .collectFrom(initiated, ConstrPlutusData.of(1))
                .attachSpendingValidator(SCRIPT)
                .payToAddress(INITIATOR.baseAddress(), Amount.ada(INITIATOR_ADA));

        TxResult result = TX_BUILDER.compose(cancelTx)
                .feePayer(INITIATOR.baseAddress())
                .withSigner(SignerProviders.signerFrom(INITIATOR))
                .withRequiredSigners(new Address(INITIATOR.baseAddress()))
                .completeAndWait();
        require(result.isSuccessful(), "cancelling the escrow failed: " + result);
        return result.getTxHash();
    }

    /**
     * The script UTxO this transaction created.
     *
     * <p>Matched on the transaction hash: a devnet is long-lived, so simply taking the first
     * UTxO at the script address can pick up leftovers from an earlier run.
     */
    private static Utxo scriptUtxoFrom(String txHash) {
        return UTXOS.getAll(SCRIPT_ADDRESS).stream()
                .filter(utxo -> utxo.getTxHash().equals(txHash))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("no script UTxO created by " + txHash));
    }

    /** The datum/redeemer encoding of a party's address: Constr 0 [PubKeyCredential, None]. */
    private static PlutusData address(Account account) {
        PlutusData paymentCredential = ConstrPlutusData.of(0,
                BytesPlutusData.of(account.getBaseAddress().getPaymentCredentialHash()
                        .orElseThrow(() -> new IllegalStateException("no payment credential"))));
        // The validator compares payment credentials only, so the staking part is left out.
        PlutusData noStakingCredential = ConstrPlutusData.of(1);
        return ConstrPlutusData.of(0, paymentCredential, noStakingCredential);
    }

    /** A Value holding only ada: {@code {"": {"": amount}}}. */
    private static PlutusData lovelace(long ada) {
        MapPlutusData tokens = MapPlutusData.builder().build()
                .put(BytesPlutusData.of(new byte[0]),
                        BigIntPlutusData.of(ada * 1_000_000L));
        return MapPlutusData.builder().build()
                .put(BytesPlutusData.of(new byte[0]), tokens);
    }

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the script address. Checking that the UTxO merely disappeared would pass by accident
     * whenever the lookup itself failed.
     *
     * <p>Polls, because a node confirms a transaction slightly before the indexer serves it.
     */
    private static boolean spendsScriptAddress(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            Optional<Boolean> spent = readInputs(txHash);
            if (spent.isPresent()) {
                return spent.get();
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    /** Empty while the transaction is not yet indexed. */
    private static Optional<Boolean> readInputs(String txHash) {
        try {
            var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
            if (!response.isSuccessful()) {
                return Optional.empty();
            }
            return Optional.of(response.getValue().getInputs().stream()
                    .anyMatch(input -> SCRIPT_ADDRESS.equals(input.getAddress())));
        } catch (Exception notIndexedYet) {
            return Optional.empty();
        }
    }

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
