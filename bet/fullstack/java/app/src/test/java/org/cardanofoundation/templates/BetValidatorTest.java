package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.BetValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Credential;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBound;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.PolicyId;
import com.bloxbean.cardano.julc.ledger.PubKeyHash;
import com.bloxbean.cardano.julc.ledger.ScriptHash;
import com.bloxbean.cardano.julc.ledger.TokenName;
import com.bloxbean.cardano.julc.ledger.TxId;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.TxOutRef;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.testkit.JulcEval;
import com.bloxbean.cardano.julc.testkit.ScriptContextTestBuilder;

/**
 * Runs the compiled multi-validator on a real Plutus VM.
 *
 * <p>Most of these tests are about conflicts of interest. A bet is only meaningful if the person
 * deciding it has nothing riding on the answer, so the referee must not be either player — and
 * that has to be enforced at both the moment the bet is created and the moment it is joined.
 */
class BetValidatorTest {

    /** The script hash doubles as the bet token's policy id, as it does for any multi-validator. */
    private static final byte[] SCRIPT_HASH = fill((byte) 0x07, 28);
    private static final Address SCRIPT = new Address(
            new Credential.ScriptCredential(new ScriptHash(SCRIPT_HASH)), Optional.empty());

    private static final byte[] PLAYER1 = fill((byte) 0x01, 28);
    private static final byte[] PLAYER2 = fill((byte) 0x02, 28);
    private static final byte[] ORACLE = fill((byte) 0x03, 28);
    private static final byte[] STRANGER = fill((byte) 0x04, 28);

    private static final byte[] TOKEN = "BET".getBytes();
    private static final byte[] EMPTY = new byte[0];

    private static final BigInteger STAKE = BigInteger.valueOf(5_000_000);
    private static final BigInteger POT = STAKE.multiply(BigInteger.TWO);
    private static final BigInteger EXPIRY = BigInteger.valueOf(1_000_000);

    private static final TxOutRef REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(BetValidator.class);

    // ── Creating ──────────────────────────────────────────────────────────────────────

    @Test
    void createsABet() {
        assertTrue(create(datum(PLAYER1, EMPTY, ORACLE), PLAYER1, endsBy(EXPIRY)));
    }

    @Test
    void createMustBeSignedByPlayerOne() {
        assertFalse(create(datum(PLAYER1, EMPTY, ORACLE), STRANGER, endsBy(EXPIRY)));
    }

    /** A creator who is also the referee could simply declare themselves the winner. */
    @Test
    void creatorCannotBeTheirOwnOracle() {
        assertFalse(create(datum(PLAYER1, EMPTY, PLAYER1), PLAYER1, endsBy(EXPIRY)));
    }

    /** A bet must open with no opponent; naming one would enrol them without their consent. */
    @Test
    void createCannotPreFillAnOpponent() {
        assertFalse(create(datum(PLAYER1, PLAYER2, ORACLE), PLAYER1, endsBy(EXPIRY)));
    }

    @Test
    void cannotCreateAfterTheExpiry() {
        assertFalse(create(datum(PLAYER1, EMPTY, ORACLE),
                PLAYER1, endsBy(EXPIRY.add(BigInteger.ONE))));
    }

    @Test
    void createRejectsAnUnboundedValidityRange() {
        assertFalse(create(datum(PLAYER1, EMPTY, ORACLE), PLAYER1, unbounded()));
    }

    // ── Joining ───────────────────────────────────────────────────────────────────────

    @Test
    void playerTwoJoins() {
        assertTrue(join(open(), joined(PLAYER2), POT, PLAYER2, true, endsBy(EXPIRY)));
    }

    @Test
    void joinMustBeSignedByTheJoiningPlayer() {
        assertFalse(join(open(), joined(PLAYER2), POT, STRANGER, true, endsBy(EXPIRY)));
    }

    /** Betting against yourself is not a bet. */
    @Test
    void playerOneCannotJoinTheirOwnBet() {
        assertFalse(join(open(), joined(PLAYER1), POT, PLAYER1, true, endsBy(EXPIRY)));
    }

    /** The referee must stay disinterested, so they cannot take a side either. */
    @Test
    void theOracleCannotJoin() {
        assertFalse(join(open(), joined(ORACLE), POT, ORACLE, true, endsBy(EXPIRY)));
    }

    /** Exactly double, not merely at least: a symmetric bet is the whole premise. */
    @Test
    void joinMustMatchTheStakeExactly() {
        assertFalse(join(open(), joined(PLAYER2), POT.subtract(BigInteger.ONE), PLAYER2, true,
                endsBy(EXPIRY)));
        assertFalse(join(open(), joined(PLAYER2), POT.add(BigInteger.valueOf(1_000_000)),
                PLAYER2, true, endsBy(EXPIRY)));
    }

    /** Without the bet token this is a look-alike UTxO, not a bet. */
    @Test
    void joinRequiresTheBetToken() {
        assertFalse(join(open(), joined(PLAYER2), POT, PLAYER2, false, endsBy(EXPIRY)));
    }

    @Test
    void joinCannotChangeTheOracle() {
        PlutusData tampered = datum(PLAYER1, PLAYER2, STRANGER);
        assertFalse(join(open(), tampered, POT, PLAYER2, true, endsBy(EXPIRY)));
    }

    @Test
    void joinCannotChangeTheExpiry() {
        PlutusData tampered = constrData(0, bytesData(PLAYER1), bytesData(PLAYER2),
                bytesData(ORACLE), intData(EXPIRY.multiply(BigInteger.TWO)));
        assertFalse(join(open(), tampered, POT, PLAYER2, true, endsBy(EXPIRY)));
    }

    @Test
    void cannotJoinATakenBet() {
        assertFalse(join(joined(PLAYER2), joined(STRANGER), POT, STRANGER, true, endsBy(EXPIRY)));
    }

    @Test
    void cannotJoinAfterTheExpiry() {
        assertFalse(join(open(), joined(PLAYER2), POT, PLAYER2, true,
                endsBy(EXPIRY.add(BigInteger.ONE))));
    }

    // ── Settling ──────────────────────────────────────────────────────────────────────

    @Test
    void oracleAnnouncesPlayerOne() {
        assertTrue(settle(joined(PLAYER2), PLAYER1, ORACLE, payout(PLAYER1), after(EXPIRY)));
    }

    @Test
    void oracleAnnouncesPlayerTwo() {
        assertTrue(settle(joined(PLAYER2), PLAYER2, ORACLE, payout(PLAYER2), after(EXPIRY)));
    }

    @Test
    void onlyTheOracleMaySettle() {
        assertFalse(settle(joined(PLAYER2), PLAYER1, PLAYER1, payout(PLAYER1), after(EXPIRY)));
    }

    /** The winner must be one of the two players, not an arbitrary third party. */
    @Test
    void theWinnerMustBeAPlayer() {
        assertFalse(settle(joined(PLAYER2), STRANGER, ORACLE, payout(STRANGER), after(EXPIRY)));
    }

    /** Naming one player but paying another would let the oracle quietly redirect the pot. */
    @Test
    void thePayoutMustGoToTheNamedWinner() {
        assertFalse(settle(joined(PLAYER2), PLAYER1, ORACLE, payout(PLAYER2), after(EXPIRY)));
    }

    @Test
    void cannotSettleEarly() {
        assertFalse(settle(joined(PLAYER2), PLAYER1, ORACLE, payout(PLAYER1),
                after(EXPIRY.subtract(BigInteger.ONE))));
    }

    /** Exactly at the expiry is not "after" it. */
    @Test
    void cannotSettleExactlyAtTheExpiry() {
        assertFalse(settle(joined(PLAYER2), PLAYER1, ORACLE, payout(PLAYER1), atExactly(EXPIRY)));
    }

    @Test
    void cannotSettleAnUnjoinedBet() {
        assertFalse(settle(open(), PLAYER1, ORACLE, payout(PLAYER1), after(EXPIRY)));
    }

    /** A datum on the payout would be state pretending the settled bet is still live. */
    @Test
    void thePayoutMustCarryNoDatum() {
        TxOut withDatum = new TxOut(wallet(PLAYER1), Value.lovelace(POT),
                new OutputDatum.OutputDatumInline(unitData()), Optional.empty());
        assertFalse(settle(joined(PLAYER2), PLAYER1, ORACLE, withDatum, after(EXPIRY)));
    }

    /** A second output is somewhere for a slice of the pot to be diverted to. */
    @Test
    void settlementAllowsOnlyOneOutput() {
        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, betUtxo(joined(PLAYER2), POT, true)))
                .output(payout(PLAYER1))
                .output(payout(STRANGER))
                .signer(new PubKeyHash(ORACLE))
                .validRange(after(EXPIRY))
                .buildPlutusData();

        assertFalse(eval.call("spend", joined(PLAYER2),
                constrData(1, bytesData(PLAYER1)), ctx).asBoolean());
    }

    // ── Harness ───────────────────────────────────────────────────────────────────────

    private boolean create(PlutusData datum, byte[] signer, Interval validRange) {
        PlutusData ctx = ScriptContextTestBuilder.minting(PolicyId.of(SCRIPT_HASH))
                .mint(betToken())
                .output(betUtxo(datum, STAKE, true))
                .signer(new PubKeyHash(signer))
                .validRange(validRange)
                .buildPlutusData();

        return eval.call("mint", unitData(), ctx).asBoolean();
    }

    private boolean join(PlutusData before, PlutusData after, BigInteger pot, byte[] signer,
            boolean withToken, Interval validRange) {
        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, betUtxo(before, STAKE, withToken)))
                .output(betUtxo(after, pot, withToken))
                .signer(new PubKeyHash(signer))
                .validRange(validRange)
                .buildPlutusData();

        // Join is constructor 0 of Action.
        return eval.call("spend", before, constrData(0), ctx).asBoolean();
    }

    private boolean settle(PlutusData datum, byte[] winner, byte[] signer, TxOut payout,
            Interval validRange) {
        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, betUtxo(datum, POT, true)))
                .output(payout)
                .signer(new PubKeyHash(signer))
                .validRange(validRange)
                .buildPlutusData();

        // AnnounceWinner is constructor 1 of Action.
        return eval.call("spend", datum, constrData(1, bytesData(winner)), ctx).asBoolean();
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────────────

    private static PlutusData open() {
        return datum(PLAYER1, EMPTY, ORACLE);
    }

    private static PlutusData joined(byte[] player2) {
        return datum(PLAYER1, player2, ORACLE);
    }

    /** {@code BetDatum { player1, player2, oracle, expiration }}. */
    private static PlutusData datum(byte[] player1, byte[] player2, byte[] oracle) {
        return constrData(0, bytesData(player1), bytesData(player2), bytesData(oracle),
                intData(EXPIRY));
    }

    private static TxOut betUtxo(PlutusData datum, BigInteger lovelace, boolean withToken) {
        Value value = withToken
                ? Value.lovelace(lovelace).merge(betToken())
                : Value.lovelace(lovelace);
        return new TxOut(SCRIPT, value, new OutputDatum.OutputDatumInline(datum),
                Optional.empty());
    }

    private static TxOut payout(byte[] keyHash) {
        return new TxOut(wallet(keyHash), Value.lovelace(POT),
                new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static Value betToken() {
        return Value.singleton(PolicyId.of(SCRIPT_HASH), new TokenName(TOKEN), BigInteger.ONE);
    }

    private static Address wallet(byte[] keyHash) {
        return new Address(new Credential.PubKeyCredential(new PubKeyHash(keyHash)),
                Optional.empty());
    }

    /** A transaction that must be included before {@code to}. */
    private static Interval endsBy(BigInteger to) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.NegInf(), true),
                new IntervalBound(new IntervalBoundType.Finite(to.subtract(BigInteger.ONE)), true));
    }

    /** A transaction that cannot start before {@code from}. */
    private static Interval after(BigInteger from) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.Finite(from.add(BigInteger.ONE)), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
    }

    private static Interval atExactly(BigInteger from) {
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
