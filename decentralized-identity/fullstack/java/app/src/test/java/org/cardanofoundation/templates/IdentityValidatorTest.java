package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.listData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.IdentityValidator;
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
 * <p>Each transition is meant to change exactly the one thing it names. Most of these tests are
 * therefore about what must <em>not</em> change: an edit that also moves value, also rotates the
 * owner, or also drops an unrelated delegate.
 */
class IdentityValidatorTest {

    private static final byte[] OWNER = fill((byte) 0x01, 28);
    private static final byte[] NEW_OWNER = fill((byte) 0x02, 28);
    private static final byte[] STRANGER = fill((byte) 0x03, 28);
    private static final byte[] ALICE = fill((byte) 0x11, 28);
    private static final byte[] BOB = fill((byte) 0x12, 28);

    private static final Address IDENTITY = new Address(
            new Credential.ScriptCredential(new ScriptHash(fill((byte) 0x07, 28))),
            Optional.empty());

    private static final Value HELD = Value.lovelace(BigInteger.valueOf(3_000_000));
    private static final BigInteger EXPIRES = BigInteger.valueOf(2_000);

    private static final TxOutRef REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(IdentityValidator.class);

    // ── Transferring ownership ────────────────────────────────────────────────────────

    @Test
    void ownerTransfersOwnership() {
        assertTrue(run(constrData(0, bytesData(NEW_OWNER)),
                state(OWNER), state(NEW_OWNER), OWNER, HELD, unbounded()));
    }

    @Test
    void strangerCannotTransferOwnership() {
        assertFalse(run(constrData(0, bytesData(NEW_OWNER)),
                state(OWNER), state(NEW_OWNER), STRANGER, HELD, unbounded()));
    }

    /** The redeemer names the new owner; the datum must agree with it. */
    @Test
    void transferMustMatchTheNamedOwner() {
        assertFalse(run(constrData(0, bytesData(NEW_OWNER)),
                state(OWNER), state(STRANGER), OWNER, HELD, unbounded()));
    }

    /** Rotating a key must not be a chance to quietly grant authority as well. */
    @Test
    void transferCannotAlsoChangeDelegates() {
        assertFalse(run(constrData(0, bytesData(NEW_OWNER)),
                state(OWNER), state(NEW_OWNER, delegate(ALICE, EXPIRES)), OWNER, HELD,
                unbounded()));
    }

    /** The identity is a state cell, not a purse. */
    @Test
    void transferCannotMoveValue() {
        assertFalse(run(constrData(0, bytesData(NEW_OWNER)),
                state(OWNER), state(NEW_OWNER), OWNER,
                Value.lovelace(BigInteger.valueOf(2_000_000)), unbounded()));
    }

    // ── Adding a delegate ─────────────────────────────────────────────────────────────

    @Test
    void ownerAddsADelegate() {
        assertTrue(run(addDelegate(ALICE, EXPIRES),
                state(OWNER), state(OWNER, delegate(ALICE, EXPIRES)), OWNER, HELD, before()));
    }

    @Test
    void strangerCannotAddADelegate() {
        assertFalse(run(addDelegate(ALICE, EXPIRES),
                state(OWNER), state(OWNER, delegate(ALICE, EXPIRES)), STRANGER, HELD, before()));
    }

    /** A second entry for the same key could outlive the first, extending a lapsed authority. */
    @Test
    void cannotAddTheSameDelegateTwice() {
        assertFalse(run(addDelegate(ALICE, EXPIRES),
                state(OWNER, delegate(ALICE, EXPIRES)),
                state(OWNER, delegate(ALICE, EXPIRES), delegate(ALICE, EXPIRES)),
                OWNER, HELD, before()));
    }

    /** Self-delegation is meaningless and would survive a transfer as a back door. */
    @Test
    void ownerCannotDelegateToThemselves() {
        assertFalse(run(addDelegate(OWNER, EXPIRES),
                state(OWNER), state(OWNER, delegate(OWNER, EXPIRES)), OWNER, HELD, before()));
    }

    /** An expiry already in the past would create authority that was never usable. */
    @Test
    void cannotAddAnAlreadyExpiredDelegate() {
        assertFalse(run(addDelegate(ALICE, EXPIRES),
                state(OWNER), state(OWNER, delegate(ALICE, EXPIRES)), OWNER, HELD,
                upTo(EXPIRES.add(BigInteger.valueOf(500)))));
    }

    /** Without an upper bound the transaction could land at any time, expiry or not. */
    @Test
    void addRejectsAnUnboundedValidityRange() {
        assertFalse(run(addDelegate(ALICE, EXPIRES),
                state(OWNER), state(OWNER, delegate(ALICE, EXPIRES)), OWNER, HELD, unbounded()));
    }

    /** One addition at a time, so every change is attributable. */
    @Test
    void cannotAddTwoDelegatesAtOnce() {
        assertFalse(run(addDelegate(ALICE, EXPIRES),
                state(OWNER),
                state(OWNER, delegate(ALICE, EXPIRES), delegate(BOB, EXPIRES)),
                OWNER, HELD, before()));
    }

    @Test
    void addCannotAlsoRotateTheOwner() {
        assertFalse(run(addDelegate(ALICE, EXPIRES),
                state(OWNER), state(NEW_OWNER, delegate(ALICE, EXPIRES)), OWNER, HELD, before()));
    }

    // ── Removing a delegate ───────────────────────────────────────────────────────────

    @Test
    void ownerRemovesADelegate() {
        assertTrue(run(constrData(2, bytesData(ALICE)),
                state(OWNER, delegate(ALICE, EXPIRES)), state(OWNER), OWNER, HELD, unbounded()));
    }

    @Test
    void strangerCannotRemoveADelegate() {
        assertFalse(run(constrData(2, bytesData(ALICE)),
                state(OWNER, delegate(ALICE, EXPIRES)), state(OWNER), STRANGER, HELD,
                unbounded()));
    }

    @Test
    void cannotRemoveADelegateThatIsNotThere() {
        assertFalse(run(constrData(2, bytesData(BOB)),
                state(OWNER, delegate(ALICE, EXPIRES)), state(OWNER), OWNER, HELD, unbounded()));
    }

    /** Revoking one named delegate must not strip the others along with it. */
    @Test
    void cannotStripEveryDelegateWhileNamingOne() {
        assertFalse(run(constrData(2, bytesData(ALICE)),
                state(OWNER, delegate(ALICE, EXPIRES), delegate(BOB, EXPIRES)),
                state(OWNER), OWNER, HELD, unbounded()));
    }

    /** The named delegate must actually be gone, not merely counted out. */
    @Test
    void removeMustDropTheNamedDelegate() {
        assertFalse(run(constrData(2, bytesData(ALICE)),
                state(OWNER, delegate(ALICE, EXPIRES), delegate(BOB, EXPIRES)),
                state(OWNER, delegate(ALICE, EXPIRES)), OWNER, HELD, unbounded()));
    }

    // ── Shape of the transition ───────────────────────────────────────────────────────

    /** Two continuing outputs would fork the identity into two equally authentic copies. */
    @Test
    void cannotForkTheIdentity() {
        TxOut input = new TxOut(IDENTITY, HELD,
                new OutputDatum.OutputDatumInline(state(OWNER)), Optional.empty());
        TxOut output = new TxOut(IDENTITY, HELD,
                new OutputDatum.OutputDatumInline(state(NEW_OWNER)), Optional.empty());

        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, input))
                .output(output)
                .output(output)
                .signer(new PubKeyHash(OWNER))
                .validRange(unbounded())
                .buildPlutusData();

        assertFalse(eval.call("spend", state(OWNER), constrData(0, bytesData(NEW_OWNER)), ctx)
                .asBoolean());
    }

    // ── Harness ───────────────────────────────────────────────────────────────────────

    private boolean run(PlutusData redeemer, PlutusData before, PlutusData after, byte[] signer,
            Value outputValue, Interval validRange) {
        TxOut input = new TxOut(IDENTITY, HELD,
                new OutputDatum.OutputDatumInline(before), Optional.empty());
        TxOut output = new TxOut(IDENTITY, outputValue,
                new OutputDatum.OutputDatumInline(after), Optional.empty());

        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, input))
                .output(output)
                .signer(new PubKeyHash(signer))
                .validRange(validRange)
                .buildPlutusData();

        return eval.call("spend", before, redeemer, ctx).asBoolean();
    }

    private static PlutusData addDelegate(byte[] key, BigInteger expires) {
        return constrData(1, bytesData(key), intData(expires));
    }

    /** {@code IdentityDatum { owner, delegates }}. */
    private static PlutusData state(byte[] owner, PlutusData... delegates) {
        return constrData(0, bytesData(owner), listData(delegates));
    }

    /** {@code Delegate { key, expires }}. */
    private static PlutusData delegate(byte[] key, BigInteger expires) {
        return constrData(0, bytesData(key), intData(expires));
    }

    /** A transaction that must be included before {@code to}. */
    private static Interval upTo(BigInteger to) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.NegInf(), true),
                new IntervalBound(new IntervalBoundType.Finite(to), true));
    }

    private static Interval before() {
        return upTo(EXPIRES.subtract(BigInteger.valueOf(500)));
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
