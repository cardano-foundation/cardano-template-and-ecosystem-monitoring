package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.MultiValidator;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * A two-player bet settled by an oracle.
 *
 * <p>One script does both jobs: minting the token that gives a bet its identity, and guarding the
 * UTxO that token travels with. Because a multi-validator's policy id <em>is</em> its script
 * hash, "this UTxO carries a token minted by the script that owns it" is a check the contract can
 * make about itself — which is what stops a look-alike UTxO at the same address from being passed
 * off as a real bet.
 *
 * <p>Three moves: create, join, settle.
 */
@MultiValidator
public class BetValidator {

    /**
     * {@code player2} is empty until someone joins — a flat sentinel rather than an
     * {@code Option}, so the datum stays cheap to compare on chain.
     */
    public record BetDatum(
            byte[] player1, byte[] player2, byte[] oracle, BigInteger expiration) {}

    public sealed interface Action permits Join, AnnounceWinner {}

    public record Join() implements Action {}

    public record AnnounceWinner(byte[] winner) implements Action {}

    /**
     * Create. The stake is locked and the terms are fixed.
     *
     * <p>The oracle may not be player 1: a creator who is also the referee could simply declare
     * themselves the winner, and the opponent's stake would be theirs for the taking.
     */
    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(PlutusData redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);

        JulcList<TxOut> atScript = ContextsLib.txInfoOutputs(tx)
                .filter(output -> isOwnScript(OutputLib.txOutAddress(output), policyId));

        if (atScript.size() != 1L) {
            return false;
        }
        BetDatum datum = (BetDatum) (Object) OutputLib.getInlineDatum(atScript.head());

        return ContextsLib.signedBy(tx, datum.player1())
                && isEmpty(datum.player2())
                && !ByteStringLib.equals(datum.oracle(), datum.player1())
                && endsBefore(ContextsLib.txInfoValidRange(tx), datum.expiration());
    }

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(BetDatum datum, Action redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();

        return switch (redeemer) {
            case Join ignored -> joins(tx, datum, own, ContextsLib.ownHash(ctx));
            case AnnounceWinner action -> settles(tx, datum, action.winner());
        };
    }

    /**
     * Join. Player 2 matches the stake and the bet becomes live.
     *
     * <p>The pot must be <em>exactly</em> double, not merely at least: a symmetric bet is the
     * whole premise, and an over- or under-funded pot would quietly change the odds.
     */
    static boolean joins(TxInfo tx, BetDatum datum, TxOut own, byte[] scriptHash) {
        // The UTxO must carry a token minted by this very script. Without it, anyone could
        // create a look-alike output at this address and "join" a bet that never existed.
        if (!ValuesLib.containsPolicy(OutputLib.txOutValue(own), scriptHash)) {
            return false;
        }
        JulcList<TxOut> continuing = ContextsLib.txInfoOutputs(tx)
                .filter(output -> sameAddress(
                        OutputLib.txOutAddress(output), OutputLib.txOutAddress(own)));

        if (continuing.size() != 1L) {
            return false;
        }
        TxOut next = continuing.head();
        BetDatum updated = (BetDatum) (Object) OutputLib.getInlineDatum(next);
        byte[] joiner = updated.player2();

        return isEmpty(datum.player2())
                && ContextsLib.signedBy(tx, joiner)
                && ByteStringLib.equals(updated.oracle(), datum.oracle())
                && ByteStringLib.equals(updated.player1(), datum.player1())
                // Betting against yourself is not a bet; being your own referee is worse.
                && !ByteStringLib.equals(joiner, datum.player1())
                && !ByteStringLib.equals(joiner, datum.oracle())
                && ValuesLib.lovelaceOf(OutputLib.txOutValue(next))
                        .equals(ValuesLib.lovelaceOf(OutputLib.txOutValue(own))
                                .multiply(BigInteger.TWO))
                && updated.expiration().equals(datum.expiration())
                && endsBefore(ContextsLib.txInfoValidRange(tx), updated.expiration());
    }

    /**
     * Settle. After expiry the oracle names one of the two players and the pot goes to them.
     *
     * <p>Exactly one output, with no datum, paying the winner directly. That shape is the payout
     * rule: with no second output there is nowhere for a slice of the pot to be diverted, and
     * with no datum there is no continuing state pretending the bet is still live.
     */
    static boolean settles(TxInfo tx, BetDatum datum, byte[] winner) {
        JulcList<TxOut> outputs = ContextsLib.txInfoOutputs(tx);
        if (outputs.size() != 1L) {
            return false;
        }
        TxOut payout = outputs.head();

        return (ByteStringLib.equals(winner, datum.player1())
                        || ByteStringLib.equals(winner, datum.player2()))
                // An unjoined bet has no opponent to lose to.
                && !isEmpty(datum.player2())
                && hasNoDatum(payout)
                && paysDirectly(OutputLib.txOutAddress(payout), winner)
                && ContextsLib.signedBy(tx, datum.oracle())
                // Strictly after expiry, so the oracle cannot call it early.
                && startsAfter(ContextsLib.txInfoValidRange(tx), datum.expiration());
    }

    static boolean isEmpty(byte[] bytes) {
        return ByteStringLib.length(bytes) == 0L;
    }

    static boolean isOwnScript(Address address, byte[] scriptHash) {
        return AddressLib.isScriptAddress(address)
                && ByteStringLib.equals(AddressLib.credentialHash(address), scriptHash);
    }

    static boolean paysDirectly(Address address, byte[] keyHash) {
        return AddressLib.isPubKeyAddress(address)
                && ByteStringLib.equals(AddressLib.credentialHash(address), keyHash);
    }

    static boolean hasNoDatum(TxOut output) {
        return switch (output.datum()) {
            case OutputDatum.NoOutputDatum ignored -> true;
            case OutputDatum.OutputDatumInline ignored -> false;
            case OutputDatum.OutputDatumHash ignored -> false;
        };
    }

    static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }

    /** The transaction must happen entirely before {@code deadline}. */
    static boolean endsBefore(Interval validRange, BigInteger deadline) {
        return switch (validRange.to().boundType()) {
            case IntervalBoundType.Finite finite -> finite.time().compareTo(deadline) < 0;
            case IntervalBoundType.NegInf ignored -> false;
            case IntervalBoundType.PosInf ignored -> false;
        };
    }

    /** The transaction cannot start until strictly after {@code deadline}. */
    static boolean startsAfter(Interval validRange, BigInteger deadline) {
        return switch (validRange.from().boundType()) {
            case IntervalBoundType.Finite finite -> finite.time().compareTo(deadline) > 0;
            case IntervalBoundType.NegInf ignored -> false;
            case IntervalBoundType.PosInf ignored -> false;
        };
    }
}
