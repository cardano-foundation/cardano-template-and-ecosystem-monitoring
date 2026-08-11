package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.randomTxOutRef_typed;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

import org.cardanofoundation.templates.validator.HtlcValidator;
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
class HtlcValidatorTest {

    private static final String SECRET = "Secret Answer";
    private static final long EXPIRATION = 1_000_000L;
    private static final byte[] OWNER = pubKeyHash((byte) 0x01);
    private static final byte[] STRANGER = pubKeyHash((byte) 0x02);

    /** Parameters are applied before evaluation, exactly as they are on-chain. */
    private final JulcEval eval = JulcEval.forClass(HtlcValidator.class,
            bytesData(sha256(SECRET)),
            intData(EXPIRATION),
            bytesData(OWNER));

    // ── Reveal ────────────────────────────────────────────────────────────────────────

    @Test
    void revealSucceedsWithThePreimage() {
        assertTrue(run(guess(SECRET), contextAfterExpiry(OWNER)));
    }

    @Test
    void revealFailsWithTheWrongPreimage() {
        assertFalse(run(guess("Wrong Answer"), contextAfterExpiry(OWNER)));
    }

    /** The reveal branch is deliberately open to anyone who knows the secret. */
    @Test
    void revealSucceedsForSomeoneOtherThanTheOwner() {
        assertTrue(run(guess(SECRET), contextAfterExpiry(STRANGER)));
    }

    // ── Refund ────────────────────────────────────────────────────────────────────────

    @Test
    void refundSucceedsAfterExpiryWhenSignedByTheOwner() {
        assertTrue(run(withdraw(), contextAfterExpiry(OWNER)));
    }

    @Test
    void refundFailsBeforeExpiry() {
        assertFalse(run(withdraw(), contextBeforeExpiry(OWNER)));
    }

    @Test
    void refundFailsWhenSignedBySomeoneElse() {
        assertFalse(run(withdraw(), contextAfterExpiry(STRANGER)));
    }

    /**
     * A transaction with no lower bound could be included at any time, so it proves nothing
     * about the expiry having passed. Accepting it would let the owner reclaim early.
     */
    @Test
    void refundFailsWhenTheTransactionHasNoLowerBound() {
        assertFalse(run(withdraw(), context(unboundedRange(), OWNER)));
    }

    /** Landing exactly on the expiry is not "after" it. */
    @Test
    void refundFailsExactlyAtTheExpiry() {
        assertFalse(run(withdraw(), context(inclusiveFrom(EXPIRATION), OWNER)));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private boolean run(PlutusData redeemer, PlutusData ctx) {
        return eval.call("spend", redeemer, ctx).asBoolean();
    }

    private static PlutusData guess(String answer) {
        return constrData(0, bytesData(answer.getBytes(StandardCharsets.UTF_8)));
    }

    private static PlutusData withdraw() {
        return constrData(1);
    }

    private static PlutusData contextAfterExpiry(byte[] signer) {
        return context(inclusiveFrom(EXPIRATION + 1), signer);
    }

    private static PlutusData contextBeforeExpiry(byte[] signer) {
        return context(inclusiveFrom(EXPIRATION - 1), signer);
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

    private static Interval unboundedRange() {
        return Interval.always();
    }

    private static byte[] pubKeyHash(byte fill) {
        byte[] hash = new byte[28];
        java.util.Arrays.fill(hash, fill);
        return hash;
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
