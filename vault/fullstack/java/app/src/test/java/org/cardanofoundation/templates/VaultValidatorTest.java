package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.VaultValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Credential;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBound;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.PubKeyHash;
import com.bloxbean.cardano.julc.ledger.ScriptHash;
import com.bloxbean.cardano.julc.ledger.TxId;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.TxOutRef;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.testkit.JulcEval;
import com.bloxbean.cardano.julc.testkit.ScriptContextTestBuilder;

/**
 * Runs the compiled validator on a real Plutus VM.
 *
 * <p>The vault's value is the delay, so the tests concentrate on the ways a delay can be
 * short-circuited: finishing early, and — less obviously — winding the clock backwards by
 * re-scheduling with a timestamp from the past.
 */
class VaultValidatorTest {

    private static final byte[] OWNER = fill((byte) 0x01, 28);
    private static final byte[] THIEF = fill((byte) 0x02, 28);

    private static final Address VAULT = new Address(
            new Credential.ScriptCredential(new ScriptHash(fill((byte) 0x07, 28))),
            Optional.empty());
    private static final Address WALLET = new Address(
            new Credential.PubKeyCredential(new PubKeyHash(OWNER)), Optional.empty());

    private static final BigInteger HELD = BigInteger.valueOf(10_000_000);
    private static final BigInteger WAIT = BigInteger.valueOf(600_000);
    private static final BigInteger LOCKED_AT = BigInteger.valueOf(1_000_000);

    private static final TxOutRef REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(VaultValidator.class,
            bytesData(OWNER), intData(WAIT));

    // ── Scheduling ────────────────────────────────────────────────────────────────────

    @Test
    void ownerSchedulesAWithdrawal() {
        assertTrue(withdraw(OWNER, HELD, LOCKED_AT, after(LOCKED_AT.add(BigInteger.ONE))));
    }

    @Test
    void thiefCannotSchedule() {
        assertFalse(withdraw(THIEF, HELD, LOCKED_AT, after(LOCKED_AT.add(BigInteger.ONE))));
    }

    /** Scheduling moves nothing; the funds must all go back into the vault. */
    @Test
    void schedulingCannotDrainTheVault() {
        assertFalse(withdraw(OWNER, HELD.subtract(BigInteger.valueOf(1_000_000)), LOCKED_AT,
                after(LOCKED_AT.add(BigInteger.ONE))));
    }

    /** Nor top it up under cover of a schedule, which would also break conservation. */
    @Test
    void schedulingCannotChangeTheBalance() {
        assertFalse(withdraw(OWNER, HELD.add(BigInteger.valueOf(1_000_000)), LOCKED_AT,
                after(LOCKED_AT.add(BigInteger.ONE))));
    }

    /**
     * The clock cannot be wound backwards. Stamping a {@code lockTime} in the future would let
     * the owner wait out most of a cool-down and then re-schedule to make the remaining delay
     * shorter than the address advertises.
     */
    @Test
    void cannotScheduleWithAFutureLockTime() {
        BigInteger future = LOCKED_AT.add(BigInteger.valueOf(500_000));
        assertFalse(withdraw(OWNER, HELD, future, after(LOCKED_AT.add(BigInteger.ONE))));
    }

    /** An unbounded lower bound says nothing about when the transaction happened. */
    @Test
    void schedulingRejectsAnUnboundedValidityRange() {
        assertFalse(withdraw(OWNER, HELD, LOCKED_AT, unbounded()));
    }

    // ── Finalizing ────────────────────────────────────────────────────────────────────

    @Test
    void ownerFinalizesAfterTheCoolDown() {
        assertTrue(finalize(OWNER, after(LOCKED_AT.add(WAIT).add(BigInteger.ONE))));
    }

    /** The whole point of the vault: a stolen key is not immediately a stolen balance. */
    @Test
    void cannotFinalizeBeforeTheCoolDown() {
        assertFalse(finalize(OWNER, after(LOCKED_AT.add(WAIT).subtract(BigInteger.ONE))));
    }

    /** Landing exactly on the deadline is not past it. */
    @Test
    void cannotFinalizeExactlyAtTheCoolDown() {
        assertFalse(finalize(OWNER, atExactly(LOCKED_AT.add(WAIT))));
    }

    @Test
    void thiefCannotFinalize() {
        assertFalse(finalize(THIEF, after(LOCKED_AT.add(WAIT).add(BigInteger.ONE))));
    }

    @Test
    void finalizeRejectsAnUnboundedValidityRange() {
        assertFalse(finalize(OWNER, unbounded()));
    }

    // ── Cancelling ────────────────────────────────────────────────────────────────────

    /** Cancelling is how the real owner defeats a theft they noticed in time. */
    @Test
    void ownerCancelsAScheduledWithdrawal() {
        assertTrue(cancel(OWNER, HELD));
    }

    @Test
    void thiefCannotCancel() {
        assertFalse(cancel(THIEF, HELD));
    }

    /** Cancelling must not become a way out with the money. */
    @Test
    void cancellingCannotDrainTheVault() {
        assertFalse(cancel(OWNER, HELD.subtract(BigInteger.valueOf(1_000_000))));
    }

    // ── Harness ───────────────────────────────────────────────────────────────────────

    private boolean withdraw(byte[] signer, BigInteger returned, BigInteger newLockTime,
            Interval validRange) {
        TxOut continuing = new TxOut(VAULT, Value.lovelace(returned),
                new OutputDatum.OutputDatumInline(datum(newLockTime)), Optional.empty());
        // Withdraw is constructor 0 of Action.
        return run(constrData(0), signer, validRange, continuing);
    }

    private boolean cancel(byte[] signer, BigInteger returned) {
        TxOut continuing = new TxOut(VAULT, Value.lovelace(returned),
                new OutputDatum.OutputDatumInline(datum(LOCKED_AT)), Optional.empty());
        // Cancel is constructor 2 of Action.
        return run(constrData(2), signer, unbounded(), continuing);
    }

    private boolean finalize(byte[] signer, Interval validRange) {
        TxOut payout = new TxOut(WALLET, Value.lovelace(HELD),
                new OutputDatum.NoOutputDatum(), Optional.empty());
        // Finalize is constructor 1 of Action.
        return run(constrData(1), signer, validRange, payout);
    }

    private boolean run(PlutusData redeemer, byte[] signer, Interval validRange, TxOut output) {
        TxOut vault = new TxOut(VAULT, Value.lovelace(HELD),
                new OutputDatum.OutputDatumInline(datum(LOCKED_AT)), Optional.empty());

        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, vault))
                .output(output)
                .signer(new PubKeyHash(signer))
                .validRange(validRange)
                .buildPlutusData();

        return eval.call("spend", datum(LOCKED_AT), redeemer, ctx).asBoolean();
    }

    /** {@code WithdrawDatum { lockTime }}. */
    private static PlutusData datum(BigInteger lockTime) {
        return constrData(0, intData(lockTime));
    }

    /** A transaction that cannot start before {@code from}. */
    private static Interval after(BigInteger from) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.Finite(from), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
    }

    private static Interval atExactly(BigInteger from) {
        return after(from);
    }

    private static Interval unbounded() {
        return new Interval(
                new IntervalBound(new IntervalBoundType.NegInf(), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}
