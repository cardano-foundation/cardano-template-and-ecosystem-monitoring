package org.cardanofoundation.templates;

import java.util.Optional;

import org.cardanofoundation.templates.validator.SimpleTransferValidator;

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
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * Send funds that only one person can spend.
 *
 * <p>The simplest thing a validator can usefully do: hold funds until the named receiver signs.
 * This example locks funds, shows that nobody else can take them, and then lets the receiver
 * collect.
 *
 * <p>Run it against a local Yaci DevKit:
 * <pre>./gradlew run</pre>
 */
public class App {

    /** Yaci DevKit's Blockfrost-compatible API. Override when the devkit is not on :8080. */
    private static final String BACKEND_URL =
            envOrDefault("CARDANO_BACKEND_URL", "http://localhost:8080/api/v1/");

    /** The devkit's pre-funded account, which plays the sender. */
    private static final String MNEMONIC = "test test test test test test test test test test "
            + "test test test test test test test test test test test test test sauce";

    private static final Network NETWORK = Networks.testnet();
    private static final Account SENDER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    /** The intended receiver. Never needs funding: it only signs, and the sender pays the fee. */
    private static final Account RECEIVER = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    /**
     * The receiver is baked into the script, so this address exists only for this receiver.
     * A different receiver produces a different script hash and a different address.
     */
    private static final PlutusScript SCRIPT = JulcScriptLoader.load(SimpleTransferValidator.class,
            BytesPlutusData.of(keyHash(RECEIVER)));
    private static final String SCRIPT_ADDRESS =
            AddressProvider.getEntAddress(SCRIPT, NETWORK).getAddress();

    public static void main(String[] args) throws Exception {
        System.out.println("Script address: " + SCRIPT_ADDRESS);
        System.out.println("Sender:   " + SENDER.baseAddress());
        System.out.println("Receiver: " + RECEIVER.baseAddress());

        // 1. Send funds to the receiver's script address.
        Utxo locked = lock(10);

        // 2. The sender cannot take them back — the funds belong to the receiver now.
        require(isRejectedFor(locked, SENDER), "only the receiver may spend these funds");
        System.out.println("Sender's attempt to reclaim rejected as expected");

        // 3. The receiver collects.
        String claimTx = claim(locked);
        System.out.println("Receiver claimed the funds in " + claimTx);
        require(spendsScriptAddress(claimTx), "the claim must consume the script UTxO");

        System.out.println("Verified: only the named receiver could spend the locked funds");
    }

    /** Pays ADA to the receiver's script address and returns the UTxO that payment created. */
    private static Utxo lock(int ada) throws Exception {
        TxResult result = TX_BUILDER.compose(new Tx()
                        .payToContract(SCRIPT_ADDRESS, Amount.ada(ada), PlutusData.unit())
                        .from(SENDER.baseAddress()))
                .feePayer(SENDER.baseAddress())
                .withSigner(SignerProviders.signerFrom(SENDER))
                .completeAndWait();
        require(result.isSuccessful(), "locking " + ada + " ADA failed: " + result);
        System.out.println("Locked " + ada + " ADA in " + result.getTxHash());

        // Match on this transaction's hash. A devnet is long-lived, so simply taking the
        // first UTxO at the script address can pick up leftovers from an earlier run.
        return UTXOS.getAll(SCRIPT_ADDRESS).stream()
                .filter(utxo -> utxo.getTxHash().equals(result.getTxHash()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no script UTxO created by " + result.getTxHash()));
    }

    private static String claim(Utxo locked) throws Exception {
        TxResult result = spend(locked, RECEIVER);
        require(result.isSuccessful(), "the receiver's claim failed: " + result);
        return result.getTxHash();
    }

    /**
     * Spends the locked UTxO on behalf of {@code claimant}.
     *
     * <p>The claimant is named as a required signer, which is what puts their key hash into the
     * signatory list the validator checks. The sender always pays the fee, so the receiver needs
     * no funds of its own.
     */
    private static TxResult spend(Utxo locked, Account claimant) throws Exception {
        ScriptTx spendTx = new ScriptTx()
                .collectFrom(locked, PlutusData.unit())
                .attachSpendingValidator(SCRIPT)
                .payToAddress(claimant.baseAddress(), Amount.ada(5))
                .withChangeAddress(SENDER.baseAddress());

        return TX_BUILDER.compose(spendTx)
                .feePayer(SENDER.baseAddress())
                .withSigner(SignerProviders.signerFrom(SENDER))
                .withSigner(SignerProviders.signerFrom(claimant))
                .withRequiredSigners(new Address(claimant.baseAddress()))
                .completeAndWait();
    }

    /**
     * Attempts a spend and reports whether the chain refused it.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a
     * failed result. Both outcomes count as a rejection.
     */
    private static boolean isRejectedFor(Utxo locked, Account claimant) {
        try {
            return !spend(locked, claimant).isSuccessful();
        } catch (Exception rejected) {
            System.out.println("  rejected: " + rejected.getMessage());
            return true;
        }
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

    private static byte[] keyHash(Account account) {
        return account.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
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
