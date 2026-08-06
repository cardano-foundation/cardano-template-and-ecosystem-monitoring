package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Optional;

import org.cardanofoundation.templates.validator.LotteryCreatorValidator;
import org.cardanofoundation.templates.validator.LotteryValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.client.crypto.Blake2bUtil;
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
 * Runs both compiled scripts on a real Plutus VM.
 *
 * <p>The security claim is that neither player can choose a number once the other's is known.
 * That rests on two rules — reveals must match their commitment, and they must happen in order —
 * so both are attacked directly here, along with the timeout paths that stop a player who simply
 * stops playing from freezing the pot.
 */
class LotteryValidatorTest {

    private static final byte[] PLAYER1 = fill((byte) 0x01, 28);
    private static final byte[] PLAYER2 = fill((byte) 0x02, 28);
    private static final byte[] STRANGER = fill((byte) 0x03, 28);

    private static final byte[] POLICY = fill((byte) 0x09, 28);
    private static final byte[] TOKEN = "LOTTERY_TOKEN".getBytes(StandardCharsets.UTF_8);

    private static final Address GAME = new Address(
            new Credential.ScriptCredential(new ScriptHash(fill((byte) 0x07, 28))),
            Optional.empty());
    private static final Address WALLET = new Address(
            new Credential.PubKeyCredential(new PubKeyHash(PLAYER1)), Optional.empty());

    /** 3 + 4 = 7, which is odd, so player 1 wins. */
    private static final byte[] N1 = "3".getBytes(StandardCharsets.UTF_8);
    private static final byte[] N2 = "4".getBytes(StandardCharsets.UTF_8);
    private static final byte[] COMMIT1 = Blake2bUtil.blake2bHash256(N1);
    private static final byte[] COMMIT2 = Blake2bUtil.blake2bHash256(N2);

    /** 2 + 4 = 6, which is even, so player 2 wins. */
    private static final byte[] N1_EVEN = "2".getBytes(StandardCharsets.UTF_8);

    private static final BigInteger END_REVEAL = BigInteger.valueOf(1_000_000);
    private static final BigInteger DELTA = BigInteger.valueOf(60_000);

    private static final byte[] EMPTY = new byte[0];

    private static final TxOutRef GAME_REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval creator = JulcEval.forClass(
            LotteryCreatorValidator.class, intData(1));

    private final JulcEval lottery = JulcEval.forClass(
            LotteryValidator.class, bytesData(POLICY), intData(1));

    // ── Opening a game ────────────────────────────────────────────────────────────────

    @Test
    void opensAGame() {
        assertTrue(open(COMMIT1, COMMIT2, true, true));
    }

    /** A lottery is a mutual agreement — one player must not be able to enrol another. */
    @Test
    void openingNeedsBothPlayers() {
        assertFalse(open(COMMIT1, COMMIT2, true, false));
        assertFalse(open(COMMIT1, COMMIT2, false, true));
    }

    /**
     * An empty commitment is the "unrevealed" sentinel, so a game opened with one would have a
     * commitment that any reveal trivially matches.
     */
    @Test
    void openingRejectsAnEmptyCommitment() {
        assertFalse(open(EMPTY, COMMIT2, true, true));
        assertFalse(open(COMMIT1, EMPTY, true, true));
    }

    // ── Revealing ─────────────────────────────────────────────────────────────────────

    @Test
    void playerOneReveals() {
        assertTrue(reveal(0, N1, state(EMPTY, EMPTY), PLAYER1, true));
    }

    @Test
    void revealMustMatchTheCommitment() {
        assertFalse(reveal(0, "9".getBytes(StandardCharsets.UTF_8), state(EMPTY, EMPTY),
                PLAYER1, true));
    }

    @Test
    void revealMustBeSignedByThatPlayer() {
        assertFalse(reveal(0, N1, state(EMPTY, EMPTY), STRANGER, true));
    }

    /** Revealing twice would let a player replace a number that is already public. */
    @Test
    void playerOneCannotRevealTwice() {
        assertFalse(reveal(0, N1, state(N1, EMPTY), PLAYER1, true));
    }

    /** A reveal must leave the game running, not quietly close it. */
    @Test
    void revealMustContinueTheGame() {
        assertFalse(reveal(0, N1, state(EMPTY, EMPTY), PLAYER1, false));
    }

    @Test
    void playerTwoRevealsAfterPlayerOne() {
        assertTrue(reveal(1, N2, state(N1, EMPTY), PLAYER2, true));
    }

    /**
     * The anti-grinding rule. If player 2 could move first, player 1 would then be choosing a
     * number with player 2's already public — and could pick one that wins.
     */
    @Test
    void playerTwoCannotRevealFirst() {
        assertFalse(reveal(1, N2, state(EMPTY, EMPTY), PLAYER2, true));
    }

    // ── Settling ──────────────────────────────────────────────────────────────────────

    @Test
    void winnerSettles() {
        assertTrue(settle(state(N1, N2), PLAYER1));
    }

    /** Parity decides, so the same game with a different n1 pays the other player. */
    @Test
    void parityPicksTheOtherWinner() {
        assertTrue(settle(state(N1_EVEN, N2), PLAYER2));
        assertFalse(settle(state(N1_EVEN, N2), PLAYER1));
    }

    @Test
    void loserCannotSettle() {
        assertFalse(settle(state(N1, N2), PLAYER2));
    }

    @Test
    void cannotSettleBeforeBothReveal() {
        assertFalse(settle(state(N1, EMPTY), PLAYER1));
        assertFalse(settle(state(EMPTY, EMPTY), PLAYER1));
    }

    @Test
    void settlingMustBurnTheToken() {
        assertFalse(spend(constrData(4), state(N1, N2), PLAYER1, false, false, farFuture()));
    }

    // ── Timeouts ──────────────────────────────────────────────────────────────────────

    /** Player 1 never revealed, so player 2 takes the pot once the window closes. */
    @Test
    void playerTwoClaimsWhenPlayerOneStalls() {
        assertTrue(spend(constrData(2), state(EMPTY, EMPTY), PLAYER2, false, true, farFuture()));
    }

    @Test
    void timeoutOneNeedsTheWindowToHaveClosed() {
        assertFalse(spend(constrData(2), state(EMPTY, EMPTY), PLAYER2, false, true, early()));
    }

    /** Once player 1 has revealed, the stall is player 2's — this path no longer applies. */
    @Test
    void timeoutOneDoesNotApplyOncePlayerOneRevealed() {
        assertFalse(spend(constrData(2), state(N1, EMPTY), PLAYER2, false, true, farFuture()));
    }

    @Test
    void playerOneClaimsWhenPlayerTwoStalls() {
        assertTrue(spend(constrData(3), state(N1, EMPTY), PLAYER1, false, true, farFuture()));
    }

    /**
     * Player 1 must wait the extra grace period. Player 2's window to reveal only opens once
     * player 1 has moved, so ending both at the same instant would let player 1 reveal at the
     * last moment and immediately claim.
     */
    @Test
    void timeoutTwoNeedsTheGracePeriod() {
        Interval justAfterEndReveal = after(END_REVEAL.add(BigInteger.ONE));
        assertFalse(spend(constrData(3), state(N1, EMPTY), PLAYER1, false, true,
                justAfterEndReveal));
    }

    /** An unbounded lower bound proves nothing about when the transaction was included. */
    @Test
    void timeoutsRejectAnUnboundedValidityRange() {
        Interval always = new Interval(
                new IntervalBound(new IntervalBoundType.NegInf(), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
        assertFalse(spend(constrData(2), state(EMPTY, EMPTY), PLAYER2, false, true, always));
    }

    // ── Builders ──────────────────────────────────────────────────────────────────────

    private boolean open(byte[] commit1, byte[] commit2, boolean p1Signs, boolean p2Signs) {
        ScriptContextTestBuilder builder = ScriptContextTestBuilder.minting(PolicyId.of(POLICY))
                .mint(token(1))
                .output(new TxOut(GAME,
                        token(1).merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                        new OutputDatum.OutputDatumInline(
                                datum(commit1, commit2, EMPTY, EMPTY)),
                        Optional.empty()));

        if (p1Signs) {
            builder = builder.signer(new PubKeyHash(PLAYER1));
        }
        if (p2Signs) {
            builder = builder.signer(new PubKeyHash(PLAYER2));
        }
        return creator.call("mint", constrData(0), builder.buildPlutusData()).asBoolean();
    }

    private boolean reveal(int which, byte[] number, PlutusData state, byte[] signer,
            boolean continues) {
        PlutusData redeemer = constrData(which, bytesData(number));
        return spend(redeemer, state, signer, continues, false, farFuture());
    }

    private boolean settle(PlutusData state, byte[] signer) {
        return spend(constrData(4), state, signer, false, true, farFuture());
    }

    private boolean spend(PlutusData redeemer, PlutusData state, byte[] signer,
            boolean continues, boolean burns, Interval validRange) {
        TxOut game = new TxOut(GAME,
                token(1).merge(Value.lovelace(BigInteger.valueOf(10_000_000))),
                new OutputDatum.OutputDatumInline(state), Optional.empty());

        ScriptContextTestBuilder builder = ScriptContextTestBuilder.spending(GAME_REF)
                .input(new TxInInfo(GAME_REF, game))
                .signer(new PubKeyHash(signer))
                .validRange(validRange)
                .mint(burns ? token(-1) : Value.lovelace(BigInteger.ONE));

        if (continues) {
            builder = builder.output(game);
        } else {
            builder = builder.output(new TxOut(WALLET,
                    Value.lovelace(BigInteger.valueOf(9_000_000)),
                    new OutputDatum.NoOutputDatum(), Optional.empty()));
        }
        return lottery.call("spend", state, redeemer, builder.buildPlutusData()).asBoolean();
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────────────

    private static PlutusData state(byte[] n1, byte[] n2) {
        return datum(COMMIT1, COMMIT2, n1, n2);
    }

    /** {@code LotteryDatum { player1, player2, commit1, commit2, n1, n2, endReveal, delta }}. */
    private static PlutusData datum(byte[] commit1, byte[] commit2, byte[] n1, byte[] n2) {
        return constrData(0,
                bytesData(PLAYER1), bytesData(PLAYER2),
                bytesData(commit1), bytesData(commit2),
                bytesData(n1), bytesData(n2),
                intData(END_REVEAL), intData(DELTA));
    }

    private static Value token(long quantity) {
        return Value.singleton(PolicyId.of(POLICY), new TokenName(TOKEN),
                BigInteger.valueOf(quantity));
    }

    private static Interval farFuture() {
        return after(END_REVEAL.add(DELTA).add(BigInteger.valueOf(10_000)));
    }

    private static Interval early() {
        return after(BigInteger.valueOf(1));
    }

    /** A transaction that cannot be included before {@code from}. */
    private static Interval after(BigInteger from) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.Finite(from), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}
