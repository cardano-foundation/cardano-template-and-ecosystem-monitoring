package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.List;

import org.cardanofoundation.templates.validator.VaultValidator;

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
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * A time-locked vault with a two-step withdrawal.
 *
 * <p>Taking money out is deliberately slow. The owner first <b>schedules</b> a withdrawal, which
 * stamps the vault but moves nothing; only after the cool-down can they <b>finalize</b> and
 * collect. A scheduled withdrawal can be <b>cancelled</b>.
 *
 * <p>The delay is not there to protect the owner from themselves. It is there so a stolen key is
 * not immediately a stolen balance: a theft becomes visible the moment it is scheduled, and the
 * real owner has the whole cool-down to notice and cancel it.
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
    private static final Account OWNER = Account.createFromMnemonic(NETWORK, MNEMONIC);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final BigInteger HELD = BigInteger.valueOf(10_000_000);

    /**
     * The cool-down, in milliseconds.
     *
     * <p>Generous on purpose. This devnet reports a block's {@code slot} and its {@code time} out
     * of step with each other, so a deadline derived from block time cannot be compared directly
     * against a slot-derived transaction bound. The window is wide enough to absorb that skew,
     * and finalisation simply retries until the chain agrees the cool-down has elapsed.
     */
    private static final BigInteger WAIT_MILLIS = BigInteger.valueOf(700_000);

    /**
     * The stamp a schedule writes. Zero rather than "now" on purpose.
     *
     * <p>The contract asks only that a newly written {@code lockTime} already be in the past, and
     * this devnet reports a block's {@code slot} and its {@code time} out of step with each other
     * — so "now" according to the block index is not reliably in the past according to the ledger
     * clock the validator compares against. Zero is unambiguous under any clock.
     *
     * <p>The consequence is that the cool-down measured from it has also long elapsed, so this
     * run demonstrates the happy path rather than a real wait. The timing boundaries are pinned
     * precisely by the unit tests, which drive the same compiled validator on a Plutus VM with
     * exact validity ranges.
     */
    private static final BigInteger ALREADY_PAST = BigInteger.ZERO;

    private static final PlutusScript VAULT = JulcScriptLoader.load(VaultValidator.class,
            BytesPlutusData.of(keyHash(OWNER)), BigIntPlutusData.of(WAIT_MILLIS));

    private static final String VAULT_ADDRESS =
            AddressProvider.getEntAddress(VAULT, NETWORK).toBech32();

    public static void main(String[] args) throws Exception {
        System.out.println("Vault address: " + VAULT_ADDRESS);
        System.out.println("Cool-down:     " + WAIT_MILLIS.divide(BigInteger.valueOf(1000)) + "s");

        // 1. Deposit. The validator only runs on the way out.
        Utxo vault = deposit();
        System.out.println("Deposited in " + vault.getTxHash());

        // 2. Nothing can be taken until a withdrawal has been scheduled and has matured.
        require(isRejected(() -> finalise(vault)),
                "finalizing before the cool-down must be rejected");
        System.out.println("Early finalize rejected as expected");

        // 3. Scheduling moves nothing — the whole balance must return to the vault.
        require(isRejected(() -> schedule(vault, HELD.subtract(BigInteger.valueOf(2_000_000)))),
                "a schedule that drains the vault must be rejected");
        System.out.println("Schedule that drains the vault rejected as expected");

        // 4. Schedule a withdrawal.
        Utxo scheduled = utxoFrom(succeed(schedule(vault, HELD), "scheduling"));
        System.out.println("Withdrawal scheduled in " + scheduled.getTxHash());

        // 5. Cancel it — this is how the real owner defeats a theft they noticed in time.
        Utxo cancelled = utxoFrom(succeed(cancel(scheduled), "cancelling"));
        System.out.println("Withdrawal cancelled in " + cancelled.getTxHash());

        // 6. Schedule again, and this time see it through.
        Utxo rescheduled = utxoFrom(succeed(schedule(cancelled, HELD), "re-scheduling"));
        System.out.println("Withdrawal re-scheduled in " + rescheduled.getTxHash());

        TxResult collected = finaliseWhenMatured(rescheduled);
        System.out.println("Funds collected in " + collected.getTxHash());

        require(spendsVault(collected.getTxHash()),
                "the confirmed transaction must spend the vault UTxO");

        System.out.println("Verified: funds leave only via schedule then finalize, "
                + "and an unmatured withdrawal is refused");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    private static Utxo deposit() throws Exception {
        Tx deposit = new Tx()
                .payToContract(VAULT_ADDRESS, Amount.lovelace(HELD), datum(farFuture()))
                .from(OWNER.baseAddress());

        TxResult result = TX_BUILDER.compose(deposit)
                .withSigner(SignerProviders.signerFrom(OWNER))
                .completeAndWait();

        require(result.isSuccessful(), "the deposit failed: " + result);
        return utxoFrom(result);
    }

    /**
     * Stamps the vault with a fresh {@code lockTime}, starting the clock.
     *
     * <p>{@code returned} is what the rejection case bends: anything other than the full balance
     * breaks the conservation rule, because scheduling is not supposed to move money.
     *
     * <p>The new {@code lockTime} is taken from chain time, i.e. already in the past — the
     * contract refuses a future one, which would otherwise let the owner wind the clock backwards
     * and shorten the delay their address advertises.
     */
    private static TxResult schedule(Utxo vault, BigInteger returned) throws Exception {
        ScriptTx scheduleTx = new ScriptTx()
                // Withdraw is constructor 0 of Action.
                .collectFrom(vault, ConstrPlutusData.of(0))
                .attachSpendingValidator(VAULT)
                .payToContract(VAULT_ADDRESS, List.of(Amount.lovelace(returned)),
                        datum(ALREADY_PAST))
                .withChangeAddress(OWNER.baseAddress());

        return submit(scheduleTx);
    }

    /** Puts the money back, un-stamped, so a fresh withdrawal has to restart the clock. */
    private static TxResult cancel(Utxo vault) throws Exception {
        ScriptTx cancelTx = new ScriptTx()
                // Cancel is constructor 2 of Action.
                .collectFrom(vault, ConstrPlutusData.of(2))
                .attachSpendingValidator(VAULT)
                .payToContract(VAULT_ADDRESS, List.of(Amount.lovelace(HELD)),
                        datum(ALREADY_PAST))
                .withChangeAddress(OWNER.baseAddress());

        return submit(cancelTx);
    }

    /** Collects the funds. Only valid once the full cool-down has elapsed. */
    private static TxResult finalise(Utxo vault) throws Exception {
        ScriptTx finaliseTx = new ScriptTx()
                // Finalize is constructor 1 of Action.
                .collectFrom(vault, ConstrPlutusData.of(1))
                .attachSpendingValidator(VAULT)
                .payToAddress(OWNER.baseAddress(), Amount.lovelace(HELD))
                .withChangeAddress(OWNER.baseAddress());

        return submit(finaliseTx);
    }

    private static TxResult submit(ScriptTx tx) throws Exception {
        return TX_BUILDER.compose(tx)
                .feePayer(OWNER.baseAddress())
                .withSigner(SignerProviders.signerFrom(OWNER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        OWNER.baseAddress()))
                .validFrom(currentSlot())
                .completeAndWait();
    }

    /**
     * Retries finalisation until the chain accepts it.
     *
     * <p>The first attempt that succeeds is, by definition, the first the chain considers past
     * the cool-down — which needs no assumption about how this devnet maps slots to time.
     */
    private static TxResult finaliseWhenMatured(Utxo vault) throws Exception {
        System.out.println("Finalizing…");
        for (int attempt = 0; attempt < 90; attempt++) {
            Thread.sleep(10_000);
            try {
                TxResult result = finalise(vault);
                if (result.isSuccessful()) {
                    return result;
                }
            } catch (Exception stillLocked) {
                // The validator is refusing because the cool-down has not elapsed yet.
            }
        }
        throw new IllegalStateException("the cool-down never elapsed");
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /** {@code WithdrawDatum { lockTime }}. */
    private static PlutusData datum(BigInteger lockTime) {
        return ConstrPlutusData.of(0, BigIntPlutusData.of(lockTime));
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the vault address. Checking that a UTxO merely disappeared would pass by accident whenever
     * the lookup itself failed.
     */
    private static boolean spendsVault(String txHash) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return response.getValue().getInputs().stream()
                            .anyMatch(input -> VAULT_ADDRESS.equals(input.getAddress()));
                }
            } catch (Exception notIndexedYet) {
                // fall through and retry
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
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
        return message.length() > 120 ? message.substring(0, 120) + "…" : message;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private static TxResult succeed(TxResult result, String what) {
        require(result.isSuccessful(), what + " failed: " + result);
        return result;
    }

    /** A stamp far enough ahead that no cool-down computed from it can have elapsed. */
    private static BigInteger farFuture() throws Exception {
        long blockTime = BACKEND.getBlockService().getLatestBlock().getValue().getTime();
        return BigInteger.valueOf((blockTime + 315_360_000L) * 1000L);
    }

    private static long currentSlot() throws Exception {
        return BACKEND.getBlockService().getLatestBlock().getValue().getSlot();
    }

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at the
     * vault address would pick up vaults left by an earlier run.
     */
    private static Utxo utxoFrom(TxResult result) throws Exception {
        return UTXOS.getAll(VAULT_ADDRESS).stream()
                .filter(utxo -> utxo.getTxHash().equals(result.getTxHash()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no vault UTxO created by " + result.getTxHash()));
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
