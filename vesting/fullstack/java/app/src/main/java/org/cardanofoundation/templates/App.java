package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.Optional;

import org.cardanofoundation.templates.validator.VestingValidator;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.Address;
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
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;
import com.bloxbean.cardano.julc.clientlib.PlutusDataAdapter;

/**
 * Time-locked vesting.
 *
 * <p>Funds are locked with a schedule in the datum. The beneficiary must wait for the lock
 * to elapse; the owner can reclaim at any time. This example walks both paths, and shows
 * the lock really binds by having the beneficiary try too early first.
 *
 * <p>Run it against a local Yaci DevKit:
 * <pre>./gradlew run</pre>
 */
public class App {

    /** Yaci DevKit's Blockfrost-compatible API. Override when the devkit is not on :8080. */
    private static final String BACKEND_URL =
            envOrDefault("CARDANO_BACKEND_URL", "http://localhost:8080/api/v1/");

    /** The devkit's pre-funded account, which plays the owner. */
    private static final String MNEMONIC = "test test test test test test test test test test "
            + "test test test test test test test test test test test test test sauce";

    /** How long funds stay locked. Kept short, because the example waits it out. */
    private static final long LOCK_SECONDS = 45;

    private static final Network NETWORK = Networks.testnet();
    private static final Account OWNER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    /**
     * A separate party, so the two branches are actually distinguishable. It never needs
     * funding: it only signs, and the owner pays every fee.
     */
    private static final Account BENEFICIARY = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final PlutusScript SCRIPT = JulcScriptLoader.load(VestingValidator.class);
    private static final String SCRIPT_ADDRESS =
            AddressProvider.getEntAddress(SCRIPT, NETWORK).getAddress();

    public static void main(String[] args) throws Exception {
        System.out.println("Script address: " + SCRIPT_ADDRESS);
        System.out.println("Owner:       " + OWNER.baseAddress());
        System.out.println("Beneficiary: " + BENEFICIARY.baseAddress());

        // 1. The clawback path. The owner is not time-gated, so this needs no waiting.
        Utxo toClawBack = lock(10, lockDeadline());
        String clawbackTx = spend(toClawBack, OWNER);
        System.out.println("Owner clawback confirmed in " + clawbackTx);
        require(spendsScriptAddress(clawbackTx), "the clawback must consume the script UTxO");

        // 2. The beneficiary path, which only opens once the lock elapses.
        BigInteger deadline = lockDeadline();
        Utxo toVest = lock(20, deadline);

        require(isRejected(toVest, BENEFICIARY),
                "the beneficiary must not be able to collect before the lock elapses");
        System.out.println("Early collection rejected as expected");

        awaitDeadline(deadline);

        String collectTx = spend(toVest, BENEFICIARY);
        System.out.println("Beneficiary collection confirmed in " + collectTx);
        require(spendsScriptAddress(collectTx), "the collection must consume the script UTxO");

        System.out.println("Verified: the owner reclaimed at will, and the beneficiary "
                + "only succeeded after the lock elapsed");
    }

    /** POSIX milliseconds, read from the chain so it matches the time the validator sees. */
    private static BigInteger lockDeadline() throws Exception {
        return BigInteger.valueOf((chainTimeSeconds() + LOCK_SECONDS) * 1_000);
    }

    /** Pays ADA to the script with a vesting schedule attached, and returns that UTxO. */
    private static Utxo lock(int ada, BigInteger lockUntil) throws Exception {
        PlutusData datum = PlutusDataAdapter.convert(new VestingValidator.VestingDatum(
                lockUntil, keyHash(OWNER), keyHash(BENEFICIARY)));

        Tx lockTx = new Tx()
                .payToContract(SCRIPT_ADDRESS, Amount.ada(ada), datum)
                .from(OWNER.baseAddress());

        TxResult result = TX_BUILDER.compose(lockTx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();
        require(result.isSuccessful(), "locking " + ada + " ADA failed: " + result);
        System.out.println("Locked " + ada + " ADA until POSIX ms " + lockUntil
                + " in " + result.getTxHash());

        // Match on this transaction's hash. A devnet is long-lived, so simply taking the
        // first UTxO at the script address can pick up leftovers from an earlier run.
        return UTXOS.getAll(SCRIPT_ADDRESS).stream()
                .filter(utxo -> utxo.getTxHash().equals(result.getTxHash()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no script UTxO created by " + result.getTxHash()));
    }

    /**
     * Unlocks the UTxO on behalf of {@code claimant}.
     *
     * <p>The claimant is named as a required signer so their key hash reaches the validator's
     * signature check, and the owner always pays the fee — the beneficiary holds no funds.
     * The validity range matters for the beneficiary branch, which is compared against the
     * transaction's lower bound.
     */
    private static String spend(Utxo utxo, Account claimant) throws Exception {
        ScriptTx spendTx = new ScriptTx()
                .collectFrom(utxo, PlutusData.unit())
                .attachSpendingValidator(SCRIPT)
                .payToAddress(claimant.baseAddress(), Amount.ada(5))
                .withChangeAddress(OWNER.baseAddress());

        TxResult result = TX_BUILDER.compose(spendTx)
                .validFrom(latestBlock().getSlot())
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withSigner(SignerProviders.signerFrom(claimant))
                .withRequiredSigners(new Address(claimant.baseAddress()))
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
    private static boolean isRejected(Utxo utxo, Account claimant) {
        try {
            spend(utxo, claimant);
            return false;
        } catch (Exception rejected) {
            System.out.println("  rejected: " + rejected.getMessage());
            return true;
        }
    }

    /** Blocks until the chain itself has moved past the lock. */
    private static void awaitDeadline(BigInteger lockUntilMillis) throws Exception {
        // A few seconds past the deadline, because the beneficiary branch needs a lower bound
        // strictly after it — landing exactly on the deadline would still be rejected.
        long target = lockUntilMillis.longValue() / 1_000 + 5;
        for (long now = chainTimeSeconds(); now < target; now = chainTimeSeconds()) {
            System.out.println("  waiting " + (target - now) + "s for the lock to elapse");
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
                    .anyMatch(input -> SCRIPT_ADDRESS.equals(input.getAddress())));
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
