package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.mapData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.BetValidator;
import org.cardanofoundation.templates.validator.OracleValidator;
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
 * Runs the compiled scripts on a real Plutus VM.
 *
 * <p>Two properties carry this contract, and both are attacked here: the oracle a bet consults
 * is fixed at creation and cannot be swapped for a friendlier one, and the win and timeout paths
 * are separated in time so the pot never has two valid destinations at once.
 */
class PriceBetValidatorTest {

    private static final byte[] OWNER = fill((byte) 0x01, 28);
    private static final byte[] PLAYER = fill((byte) 0x02, 28);
    private static final byte[] STRANGER = fill((byte) 0x03, 28);

    private static final byte[] ORACLE_HASH = fill((byte) 0x09, 28);
    private static final byte[] OTHER_ORACLE = fill((byte) 0x0A, 28);

    private static final Address BET = script(fill((byte) 0x07, 28));
    private static final Address ORACLE = script(ORACLE_HASH);
    private static final Address ROGUE_ORACLE = script(OTHER_ORACLE);

    private static final BigInteger TARGET = BigInteger.valueOf(100);
    private static final BigInteger DEADLINE = BigInteger.valueOf(1_000_000);
    private static final BigInteger STAKE = BigInteger.valueOf(5_000_000);
    private static final BigInteger POT = STAKE.multiply(BigInteger.TWO);
    private static final BigInteger EXPIRY = DEADLINE.add(BigInteger.valueOf(100_000));

    private static final TxOutRef BET_REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);
    private static final TxOutRef ORACLE_REF =
            new TxOutRef(new TxId(fill((byte) 0xBB, 32)), BigInteger.ZERO);

    private final JulcEval bet = JulcEval.forClass(BetValidator.class);
    private final JulcEval oracle = JulcEval.forClass(OracleValidator.class);

    // ── Joining ───────────────────────────────────────────────────────────────────────

    @Test
    void playerJoins() {
        assertTrue(join(open(), joined(), POT, PLAYER, endsBy(DEADLINE)));
    }

    /** The signer must be the player being recorded, not a third party enrolling them. */
    @Test
    void joinMustBeSignedByTheJoiningPlayer() {
        assertFalse(join(open(), joined(), POT, STRANGER, endsBy(DEADLINE)));
    }

    @Test
    void joinMustMatchTheStake() {
        assertFalse(join(open(), joined(), POT.subtract(BigInteger.ONE), PLAYER,
                endsBy(DEADLINE)));
    }

    @Test
    void cannotJoinATakenBet() {
        assertFalse(join(joined(), joined(), POT, PLAYER, endsBy(DEADLINE)));
    }

    /** The whole point of pinning the oracle: joining must not re-point the bet. */
    @Test
    void joinCannotSwapTheOracle() {
        PlutusData tampered = datum(Optional.of(PLAYER), OTHER_ORACLE, TARGET, DEADLINE);
        assertFalse(join(open(), tampered, POT, PLAYER, endsBy(DEADLINE)));
    }

    /** Nor lower the bar the price has to clear. */
    @Test
    void joinCannotLowerTheTarget() {
        PlutusData tampered = datum(Optional.of(PLAYER), ORACLE_HASH, BigInteger.ONE, DEADLINE);
        assertFalse(join(open(), tampered, POT, PLAYER, endsBy(DEADLINE)));
    }

    @Test
    void joinCannotExtendTheDeadline() {
        PlutusData tampered = datum(Optional.of(PLAYER), ORACLE_HASH, TARGET,
                DEADLINE.multiply(BigInteger.TWO));
        assertFalse(join(open(), tampered, POT, PLAYER, endsBy(DEADLINE)));
    }

    @Test
    void cannotJoinAfterTheDeadline() {
        assertFalse(join(open(), joined(), POT, PLAYER,
                endsBy(DEADLINE.add(BigInteger.ONE))));
    }

    // ── Winning ───────────────────────────────────────────────────────────────────────

    @Test
    void playerWinsWhenThePriceClearsTheTarget() {
        assertTrue(win(reading(TARGET, EXPIRY), ORACLE, PLAYER, POT, endsBy(DEADLINE)));
    }

    @Test
    void playerLosesWhenThePriceIsShort() {
        assertFalse(win(reading(TARGET.subtract(BigInteger.ONE), EXPIRY), ORACLE, PLAYER, POT,
                endsBy(DEADLINE)));
    }

    /** A reading that has lapsed by the end of the transaction is a stale price. */
    @Test
    void winRejectsAnExpiredReading() {
        BigInteger lapsed = DEADLINE.subtract(BigInteger.valueOf(100_000));
        assertFalse(win(reading(TARGET, lapsed), ORACLE, PLAYER, POT, endsBy(DEADLINE)));
    }

    /** A bet trusts one oracle; a reading from anywhere else is not evidence. */
    @Test
    void winRejectsAnUnnamedOracle() {
        assertFalse(win(reading(TARGET, EXPIRY), ROGUE_ORACLE, PLAYER, POT, endsBy(DEADLINE)));
    }

    @Test
    void winMustBeSignedByThePlayer() {
        assertFalse(win(reading(TARGET, EXPIRY), ORACLE, STRANGER, POT, endsBy(DEADLINE)));
    }

    /** The player must actually receive the pot, not merely trigger the branch. */
    @Test
    void winMustPayThePlayerTheWholePot() {
        assertFalse(win(reading(TARGET, EXPIRY), ORACLE, PLAYER, POT.subtract(BigInteger.ONE),
                endsBy(DEADLINE)));
    }

    @Test
    void cannotWinAfterTheDeadline() {
        assertFalse(win(reading(TARGET, EXPIRY), ORACLE, PLAYER, POT,
                endsBy(DEADLINE.add(BigInteger.ONE))));
    }

    // ── Timing out ────────────────────────────────────────────────────────────────────

    @Test
    void ownerReclaimsAfterTheDeadline() {
        assertTrue(timeout(OWNER, POT, startsAfter(DEADLINE.add(BigInteger.ONE))));
    }

    @Test
    void cannotReclaimBeforeTheDeadline() {
        assertFalse(timeout(OWNER, POT, startsAfter(DEADLINE.subtract(BigInteger.ONE))));
    }

    /**
     * The boundary. {@code Win} needs the transaction to end at or before the deadline and
     * {@code Timeout} needs it to start strictly after, so landing exactly on the deadline is a
     * timeout too early — there is no slot where both paths are open.
     */
    @Test
    void cannotReclaimExactlyAtTheDeadline() {
        assertFalse(timeout(OWNER, POT, startsAfter(DEADLINE)));
    }

    @Test
    void strangerCannotReclaim() {
        assertFalse(timeout(STRANGER, POT, startsAfter(DEADLINE.add(BigInteger.ONE))));
    }

    @Test
    void reclaimMustPayTheOwnerTheWholePot() {
        assertFalse(timeout(OWNER, POT.subtract(BigInteger.ONE),
                startsAfter(DEADLINE.add(BigInteger.ONE))));
    }

    /** Without a lower bound the transaction could land at any time, deadline or not. */
    @Test
    void reclaimRejectsAnUnboundedValidityRange() {
        assertFalse(timeout(OWNER, POT, unbounded()));
    }

    // ── The oracle UTxO itself ────────────────────────────────────────────────────────

    /** A published reading cannot be withdrawn or rewritten while bets rely on it. */
    @Test
    void oracleReadingsCannotBeSpent() {
        PlutusData ctx = ScriptContextTestBuilder.spending(ORACLE_REF)
                .input(new TxInInfo(ORACLE_REF, oracleUtxo(reading(TARGET, EXPIRY))))
                .signer(new PubKeyHash(OWNER))
                .buildPlutusData();
        assertFalse(oracle.call("spend", unitData(), unitData(), ctx).asBoolean());
    }

    // ── Harness ───────────────────────────────────────────────────────────────────────

    private boolean join(PlutusData before, PlutusData after, BigInteger continuing,
            byte[] signer, Interval validRange) {
        PlutusData ctx = ScriptContextTestBuilder.spending(BET_REF)
                .input(new TxInInfo(BET_REF, betUtxo(before, STAKE)))
                .output(new TxOut(BET, Value.lovelace(continuing),
                        new OutputDatum.OutputDatumInline(after), Optional.empty()))
                .signer(new PubKeyHash(signer))
                .validRange(validRange)
                .buildPlutusData();

        return bet.call("spend", before, constrData(0), ctx).asBoolean();
    }

    private boolean win(PlutusData oracleDatum, Address oracleAddress, byte[] signer,
            BigInteger paid, Interval validRange) {
        PlutusData state = joined();

        PlutusData ctx = ScriptContextTestBuilder.spending(BET_REF)
                .input(new TxInInfo(BET_REF, betUtxo(state, POT)))
                .referenceInput(new TxInInfo(ORACLE_REF,
                        new TxOut(oracleAddress, Value.lovelace(BigInteger.valueOf(2_000_000)),
                                new OutputDatum.OutputDatumInline(oracleDatum), Optional.empty())))
                .output(payment(PLAYER, paid))
                .signer(new PubKeyHash(signer))
                .validRange(validRange)
                .buildPlutusData();

        return bet.call("spend", state, constrData(1), ctx).asBoolean();
    }

    private boolean timeout(byte[] signer, BigInteger paid, Interval validRange) {
        PlutusData state = joined();

        PlutusData ctx = ScriptContextTestBuilder.spending(BET_REF)
                .input(new TxInInfo(BET_REF, betUtxo(state, POT)))
                .output(payment(OWNER, paid))
                .signer(new PubKeyHash(signer))
                .validRange(validRange)
                .buildPlutusData();

        return bet.call("spend", state, constrData(2), ctx).asBoolean();
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────────────

    private static PlutusData open() {
        return datum(Optional.empty(), ORACLE_HASH, TARGET, DEADLINE);
    }

    private static PlutusData joined() {
        return datum(Optional.of(PLAYER), ORACLE_HASH, TARGET, DEADLINE);
    }

    /** {@code PriceBetDatum { owner, player, oracleHash, targetRate, deadline, betAmount }}. */
    private static PlutusData datum(Optional<byte[]> player, byte[] oracleHash,
            BigInteger target, BigInteger deadline) {
        PlutusData maybePlayer = player.isPresent()
                ? constrData(0, bytesData(player.get()))   // Some
                : constrData(1);                            // None
        return constrData(0,
                bytesData(OWNER), maybePlayer, bytesData(oracleHash),
                intData(target), intData(deadline), intData(STAKE));
    }

    /** {@code OracleDatum { GenericData { 0 -> price, 1 -> timestamp, 2 -> expiry } }}. */
    private static PlutusData reading(BigInteger price, BigInteger expiry) {
        PlutusData map = mapData(
                intData(0), intData(price),
                intData(1), intData(BigInteger.ZERO),
                intData(2), intData(expiry));
        return constrData(0, constrData(2, map));
    }

    private static TxOut betUtxo(PlutusData state, BigInteger lovelace) {
        return new TxOut(BET, Value.lovelace(lovelace),
                new OutputDatum.OutputDatumInline(state), Optional.empty());
    }

    private static TxOut oracleUtxo(PlutusData reading) {
        return new TxOut(ORACLE, Value.lovelace(BigInteger.valueOf(2_000_000)),
                new OutputDatum.OutputDatumInline(reading), Optional.empty());
    }

    private static TxOut payment(byte[] keyHash, BigInteger lovelace) {
        return new TxOut(
                new Address(new Credential.PubKeyCredential(new PubKeyHash(keyHash)),
                        Optional.empty()),
                Value.lovelace(lovelace), new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static Address script(byte[] hash) {
        return new Address(new Credential.ScriptCredential(new ScriptHash(hash)), Optional.empty());
    }

    /** A transaction that must be included at or before {@code to}. */
    private static Interval endsBy(BigInteger to) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.NegInf(), true),
                new IntervalBound(new IntervalBoundType.Finite(to), true));
    }

    /** A transaction that cannot start before {@code from}. */
    private static Interval startsAfter(BigInteger from) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.Finite(from), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
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
