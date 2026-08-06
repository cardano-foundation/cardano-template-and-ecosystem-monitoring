package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.CryptoLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;

/**
 * A two-player lottery decided by numbers neither player can grind.
 *
 * <p>Both players publish {@code blake2b_256(number)} up front, then reveal in a fixed order:
 * player 1 first, player 2 second. The ordering is the anti-grinding rule. Player 2 can see
 * player 1's <em>commitment</em> from the start, but not the number behind it — and by the time
 * player 1 reveals, player 2's own commitment is already locked in. Neither can pick a number
 * once the other's is known.
 *
 * <p>The winner is the parity of the sum, which neither player controls alone.
 *
 * <p>The two timeout paths exist so a player who simply stops cannot freeze the pot. They are
 * asymmetric on purpose: player 2 claims after {@code endReveal}, but player 1 must wait a
 * further {@code delta}, because player 2's window to reveal only opens once player 1 has moved.
 */
@SpendingValidator
public class LotteryValidator {

    /** The game's identity token; the UTxO being spent must carry it. */
    @Param static byte[] policyId;

    @Param static BigInteger gameIndex;

    public sealed interface LotteryRedeemer
            permits Reveal1, Reveal2, Timeout1, Timeout2, Settle {}

    public record Reveal1(byte[] n1) implements LotteryRedeemer {}

    public record Reveal2(byte[] n2) implements LotteryRedeemer {}

    public record Timeout1() implements LotteryRedeemer {}

    public record Timeout2() implements LotteryRedeemer {}

    public record Settle() implements LotteryRedeemer {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(LotteryLib.LotteryDatum datum, LotteryRedeemer redeemer,
            ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();

        // The UTxO must carry the game token. Without this, a look-alike output at the same
        // address could be spent to drive a settlement for a game that does not exist.
        if (!OutputLib.valueHasToken(OutputLib.txOutValue(own), policyId,
                LotteryLib.tokenName())) {
            return false;
        }

        // Closing the game means leaving nothing behind at this address. Reveals must continue
        // the state; settlement and timeouts must not.
        boolean closed = ContextsLib.txInfoOutputs(tx)
                .filter(output -> sameAddress(
                        OutputLib.txOutAddress(output), OutputLib.txOutAddress(own)))
                .isEmpty();

        return switch (redeemer) {
            case Reveal1 reveal -> reveals(tx, datum.player1(), datum.n1(), reveal.n1(),
                    datum.commit1()) && !closed;

            // n1 must already be set: player 2 only moves after player 1.
            case Reveal2 reveal -> !LotteryLib.isEmpty(datum.n1())
                    && reveals(tx, datum.player2(), datum.n2(), reveal.n2(), datum.commit2())
                    && !closed;

            case Timeout1 ignored -> LotteryLib.isEmpty(datum.n1())
                    && LotteryLib.validAfter(ContextsLib.txInfoValidRange(tx), datum.endReveal())
                    && ContextsLib.signedBy(tx, datum.player2())
                    && closed
                    && burnsTheToken(tx);

            case Timeout2 ignored -> !LotteryLib.isEmpty(datum.n1())
                    && LotteryLib.isEmpty(datum.n2())
                    && LotteryLib.validAfter(ContextsLib.txInfoValidRange(tx),
                            datum.endReveal().add(datum.delta()))
                    && ContextsLib.signedBy(tx, datum.player1())
                    && closed
                    && burnsTheToken(tx);

            case Settle ignored -> settles(tx, datum) && closed && burnsTheToken(tx);
        };
    }

    /**
     * A reveal is valid when the player signs, has not already revealed, and the number hashes
     * to their commitment. The number must be non-empty because empty <em>is</em> the
     * "unrevealed" sentinel.
     */
    static boolean reveals(TxInfo tx, byte[] player, byte[] current, byte[] revealed,
            byte[] commitment) {
        return ContextsLib.signedBy(tx, player)
                && LotteryLib.isEmpty(current)
                && !LotteryLib.isEmpty(revealed)
                && ByteStringLib.equals(CryptoLib.blake2b_256(revealed), commitment);
    }

    /** Both numbers are out; the parity of their sum picks the winner, who must sign. */
    static boolean settles(TxInfo tx, LotteryLib.LotteryDatum datum) {
        if (LotteryLib.isEmpty(datum.n1()) || LotteryLib.isEmpty(datum.n2())) {
            return false;
        }
        BigInteger sum = ByteStringLib.utf8ToInteger(datum.n1())
                .add(ByteStringLib.utf8ToInteger(datum.n2()));

        byte[] winner = sum.mod(BigInteger.TWO).equals(BigInteger.ONE)
                ? datum.player1()
                : datum.player2();

        return ContextsLib.signedBy(tx, winner);
    }

    static boolean burnsTheToken(TxInfo tx) {
        return LotteryLib.onlyToken(ContextsLib.txInfoMint(tx), policyId, BigInteger.valueOf(-1));
    }

    static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }
}
