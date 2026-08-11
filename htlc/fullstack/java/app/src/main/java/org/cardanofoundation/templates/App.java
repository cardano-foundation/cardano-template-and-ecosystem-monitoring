package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Optional;

import org.cardanofoundation.templates.validator.HtlcValidator;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.backend.model.Block;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;
import com.bloxbean.cardano.julc.clientlib.PlutusDataAdapter;

/**
 * Hash Time-Locked Contract.
 *
 * <p>Funds are locked against a hash and an expiry, and there are exactly two ways out:
 * reveal the secret, or wait for the expiry and let the owner reclaim. This example walks
 * both, and shows that the refund really is gated on time by attempting it too early first.
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

    private static final String SECRET = "Secret Answer";

    /** How long the reveal window stays open. Kept short, because the example waits it out. */
    private static final long REVEAL_WINDOW_SECONDS = 45;

    private static final Network NETWORK = Networks.testnet();
    private static final Account ACCOUNT = Account.createFromMnemonic(NETWORK, MNEMONIC);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    /** Both are fixed once the parameters are known, and the parameters need chain time. */
    private static PlutusScript script;
    private static String scriptAddress;

    public static void main(String[] args) throws Exception {
        // Times come from the chain rather than the local clock, so the example does not
        // assume the devnet's slot-to-time mapping agrees with this machine's wall clock.
        long expirationSeconds = chainTimeSeconds() + REVEAL_WINDOW_SECONDS;
        BigInteger expirationMillis = BigInteger.valueOf(expirationSeconds * 1_000);

        // Parameters are baked into the script, so each HTLC instance gets its own address
        // and its terms cannot be altered by whoever later builds the spending transaction.
        script = JulcScriptLoader.load(HtlcValidator.class,
                BytesPlutusData.of(sha256(SECRET)),
                BigIntPlutusData.of(expirationMillis),
                BytesPlutusData.of(ownerKeyHash()));
        scriptAddress = AddressProvider.getEntAddress(script, NETWORK).getAddress();

        System.out.println("Script address: " + scriptAddress);
        System.out.println("Reveal window closes at POSIX ms " + expirationMillis);

        // 1. The reveal path. Knowing the secret is the only requirement.
        Utxo forReveal = lock(20);
        String revealTx = spend(forReveal, new HtlcValidator.Guess(SECRET.getBytes(StandardCharsets.UTF_8)));
        System.out.println("Reveal confirmed in " + revealTx);
        require(spendsScriptAddress(revealTx), "the reveal must consume the script UTxO");

        // 2. The refund path, which the owner may only take once the window has closed.
        Utxo forRefund = lock(10);

        require(isRejected(forRefund, new HtlcValidator.Withdraw()),
                "a refund before expiry must be rejected");
        System.out.println("Early refund rejected as expected");

        awaitExpiry(expirationSeconds);

        String refundTx = spend(forRefund, new HtlcValidator.Withdraw());
        System.out.println("Refund confirmed in " + refundTx);
        require(spendsScriptAddress(refundTx), "the refund must consume the script UTxO");

        System.out.println("Verified: both paths consumed script UTxOs, and the refund "
                + "was only accepted once the reveal window had closed");
    }

    /** Pays ADA to the script address and returns the UTxO that payment created. */
    private static Utxo lock(int ada) throws Exception {
        Tx lockTx = new Tx()
                .payToContract(scriptAddress, Amount.ada(ada), PlutusData.unit())
                .from(ACCOUNT.baseAddress());

        TxResult result = TX_BUILDER.compose(lockTx)
                .feePayer(ACCOUNT.baseAddress())
                .withSigner(SignerProviders.signerFrom(ACCOUNT))
                .completeAndWait();
        require(result.isSuccessful(), "locking " + ada + " ADA failed: " + result);
        System.out.println("Locked " + ada + " ADA in " + result.getTxHash());

        // Match on this transaction's hash. A devnet is long-lived, so simply taking the
        // first UTxO at the script address can pick up leftovers from an earlier run.
        return UTXOS.getAll(scriptAddress).stream()
                .filter(utxo -> utxo.getTxHash().equals(result.getTxHash()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no script UTxO created by " + result.getTxHash()));
    }

    /**
     * Unlocks the UTxO with the given redeemer.
     *
     * <p>The validity range matters here. A refund is only allowed strictly after the expiry,
     * and the validator reads that from the transaction's lower bound — so the transaction has
     * to state when it is allowed to run. The owner is named as a required signer because the
     * refund branch checks the signature.
     */
    private static String spend(Utxo utxo, HtlcValidator.Redeemer redeemer) throws Exception {
        ScriptTx spendTx = new ScriptTx()
                .collectFrom(utxo, PlutusDataAdapter.convert(redeemer))
                .attachSpendingValidator(script)
                .payToAddress(ACCOUNT.baseAddress(), Amount.ada(5))
                .withChangeAddress(ACCOUNT.baseAddress());

        TxResult result = TX_BUILDER.compose(spendTx)
                .validFrom(latestBlock().getSlot())
                .feePayer(ACCOUNT.baseAddress())
                .withSigner(SignerProviders.signerFrom(ACCOUNT))
                .withRequiredSigners(ACCOUNT.getBaseAddress())
                .completeAndWait();
        require(result.isSuccessful(), "spending the script UTxO failed: " + result);
        return result.getTxHash();
    }

    /**
     * Attempts a spend and reports whether the chain refused it.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a
     * failed result. Both outcomes count as a rejection.
     */
    private static boolean isRejected(Utxo utxo, HtlcValidator.Redeemer redeemer) {
        try {
            spend(utxo, redeemer);
            return false;
        } catch (Exception rejected) {
            System.out.println("  rejected: " + rejected.getMessage());
            return true;
        }
    }

    /** Blocks until the chain itself has moved past the expiry. */
    private static void awaitExpiry(long expirationSeconds) throws Exception {
        // A few seconds past the deadline, because the refund needs a lower bound that is
        // strictly after it — landing exactly on the expiry would still be rejected.
        long target = expirationSeconds + 5;
        for (long now = chainTimeSeconds(); now < target; now = chainTimeSeconds()) {
            System.out.println("  waiting " + (target - now) + "s for the reveal window to close");
            Thread.sleep(5_000);
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
                    .anyMatch(input -> scriptAddress.equals(input.getAddress())));
        } catch (Exception notIndexedYet) {
            return Optional.empty();
        }
    }

    private static long chainTimeSeconds() throws Exception {
        return latestBlock().getTime();
    }

    private static Block latestBlock() throws Exception {
        var response = BACKEND.getBlockService().getLatestBlock();
        require(response.isSuccessful(), "could not read the latest block: " + response.getResponse());
        return response.getValue();
    }

    private static byte[] ownerKeyHash() {
        return ACCOUNT.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
    }

    /**
     * Hashes with the JDK rather than julc's {@code CryptoLib}: those methods are compile-time
     * intrinsics for the on-chain compiler and throw when called on the JVM.
     */
    private static byte[] sha256(String value) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
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
