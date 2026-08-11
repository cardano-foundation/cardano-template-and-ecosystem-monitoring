package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.randomTxOutRef_typed;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.Arrays;

import org.cardanofoundation.templates.validator.VestingValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBound;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.PubKeyHash;
import com.bloxbean.cardano.julc.testkit.JulcEval;
import com.bloxbean.cardano.julc.testkit.ScriptContextTestBuilder;

/**
 * Runs the compiled validator on a real Plutus VM, so these tests exercise the same UPLC the
 * chain would execute — not the Java source.
 */
class VestingValidatorTest {

    private static final long LOCK_UNTIL = 1_672_843_961_000L;
    private static final byte[] OWNER = pubKeyHash((byte) 0x01);
    private static final byte[] BENEFICIARY = pubKeyHash((byte) 0x02);
    private static final byte[] STRANGER = pubKeyHash((byte) 0x03);

    private final JulcEval eval = JulcEval.forClass(VestingValidator.class);

    // ── Owner clawback ────────────────────────────────────────────────────────────────

    @Test
    void ownerCanReclaimBeforeTheLockElapses() {
        assertTrue(run(signedBy(OWNER, LOCK_UNTIL - 1)));
    }

    @Test
    void ownerCanReclaimAfterTheLockElapses() {
        assertTrue(run(signedBy(OWNER, LOCK_UNTIL + 1)));
    }

    /** The owner branch is not time-gated, so it must not depend on a bounded range either. */
    @Test
    void ownerCanReclaimWithAnUnboundedRange() {
        assertTrue(run(context(Interval.always(), OWNER)));
    }

    // ── Beneficiary collection ────────────────────────────────────────────────────────

    @Test
    void beneficiaryCanCollectAfterTheLockElapses() {
        assertTrue(run(signedBy(BENEFICIARY, LOCK_UNTIL + 1)));
    }

    @Test
    void beneficiaryCannotCollectBeforeTheLockElapses() {
        assertFalse(run(signedBy(BENEFICIARY, LOCK_UNTIL - 1)));
    }

    /** Landing exactly on the deadline is not "after" it. */
    @Test
    void beneficiaryCannotCollectExactlyAtTheDeadline() {
        assertFalse(run(signedBy(BENEFICIARY, LOCK_UNTIL)));
    }

    /**
     * A transaction with no lower bound could be included at any time, so it proves nothing
     * about the lock having elapsed. Accepting it would defeat the vesting schedule entirely.
     */
    @Test
    void beneficiaryCannotCollectWithAnUnboundedRange() {
        assertFalse(run(context(Interval.always(), BENEFICIARY)));
    }

    // ── Everyone else ─────────────────────────────────────────────────────────────────

    @Test
    void anUnrelatedSignerIsRejectedEvenAfterTheLockElapses() {
        assertFalse(run(signedBy(STRANGER, LOCK_UNTIL + 1)));
    }

    @Test
    void anUnsignedTransactionIsRejected() {
        PlutusData ctx = ScriptContextTestBuilder.spending(randomTxOutRef_typed())
                .validRange(inclusiveFrom(LOCK_UNTIL + 1))
                .buildPlutusData();

        assertFalse(run(ctx));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private boolean run(PlutusData ctx) {
        return eval.call("spend", datum(), unitData(), ctx).asBoolean();
    }

    private static PlutusData datum() {
        return constrData(0, intData(LOCK_UNTIL), bytesData(OWNER), bytesData(BENEFICIARY));
    }

    private static PlutusData signedBy(byte[] signer, long lowerBound) {
        return context(inclusiveFrom(lowerBound), signer);
    }

    private static PlutusData context(Interval validRange, byte[] signer) {
        return ScriptContextTestBuilder.spending(randomTxOutRef_typed())
                .validRange(validRange)
                .signer(new PubKeyHash(signer))
                .buildPlutusData();
    }

    private static Interval inclusiveFrom(long time) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.Finite(BigInteger.valueOf(time)), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
    }

    private static byte[] pubKeyHash(byte fill) {
        byte[] hash = new byte[28];
        Arrays.fill(hash, fill);
        return hash;
    }
}
