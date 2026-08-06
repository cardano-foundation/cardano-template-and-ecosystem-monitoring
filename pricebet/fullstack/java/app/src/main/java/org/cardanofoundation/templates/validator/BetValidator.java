package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * A bet on whether a price clears a target before a deadline, settled by an oracle.
 *
 * <p>The owner stakes first and names the terms. A player joins by matching the stake. At
 * settlement an oracle UTxO is consulted as a <em>reference</em> input — read, not consumed — so
 * any number of bets can resolve against the same reading in the same block without competing
 * for it.
 *
 * <p>The two exits cannot overlap. {@code Win} requires the transaction to end at or before the
 * deadline; {@code Timeout} requires it to start strictly after. There is no slot in which both
 * are valid, so the pot has exactly one destination at any moment.
 */
@SpendingValidator
public class BetValidator {

    public sealed interface PriceBetRedeemer permits Join, Win, Timeout {}

    public record Join() implements PriceBetRedeemer {}

    public record Win() implements PriceBetRedeemer {}

    public record Timeout() implements PriceBetRedeemer {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(PriceBetLib.PriceBetDatum datum, PriceBetRedeemer redeemer,
            ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();

        return switch (redeemer) {
            case Join ignored -> joins(tx, datum, own);
            case Win ignored -> wins(tx, datum, own);
            case Timeout ignored -> timesOut(tx, datum, own);
        };
    }

    /**
     * Taking the other side of the bet: match the stake and record who joined.
     *
     * <p>Only the terms' <em>player</em> field may change. Everything else — including the oracle
     * the bet trusts and the target it must clear — carries over untouched.
     */
    static boolean joins(TxInfo tx, PriceBetLib.PriceBetDatum datum, TxOut own) {
        if (datum.player().isPresent()) {
            return false;
        }
        JulcList<TxOut> continuing = ContextsLib.txInfoOutputs(tx)
                .filter(output -> PriceBetLib.sameAddress(
                        OutputLib.txOutAddress(output), OutputLib.txOutAddress(own)));

        if (continuing.size() != 1L) {
            return false;
        }
        TxOut next = continuing.head();
        PriceBetLib.PriceBetDatum updated =
                (PriceBetLib.PriceBetDatum) (Object) OutputLib.getInlineDatum(next);

        if (updated.player().isEmpty()) {
            return false;
        }
        // The joining signer must be the player being recorded, so nobody can enrol a third
        // party into a bet they never agreed to.
        return ContextsLib.signedBy(tx, updated.player().get())
                && ByteStringLib.equals(updated.owner(), datum.owner())
                && ByteStringLib.equals(updated.oracleHash(), datum.oracleHash())
                && updated.targetRate().equals(datum.targetRate())
                && updated.deadline().equals(datum.deadline())
                && updated.betAmount().equals(datum.betAmount())
                && ValuesLib.lovelaceOf(OutputLib.txOutValue(next))
                        .compareTo(datum.betAmount().multiply(BigInteger.TWO)) >= 0
                && PriceBetLib.endsBefore(ContextsLib.txInfoValidRange(tx), datum.deadline());
    }

    /** The player claims the pot because the oracle says the price cleared the target. */
    static boolean wins(TxInfo tx, PriceBetLib.PriceBetDatum datum, TxOut own) {
        if (datum.player().isEmpty()) {
            return false;
        }
        byte[] player = datum.player().get();
        if (!ContextsLib.signedBy(tx, player)) {
            return false;
        }

        // Read, do not consume: a reference input lets many bets resolve against one reading.
        JulcList<TxInInfo> oracles = ContextsLib.txInfoRefInputs(tx)
                .filter(input -> isOracle(input, datum.oracleHash()));

        if (oracles.isEmpty()) {
            return false;
        }
        PriceBetLib.OracleDatum oracle = (PriceBetLib.OracleDatum) (Object)
                OutputLib.getInlineDatum(oracles.head().resolved());

        BigInteger pot = ValuesLib.lovelaceOf(OutputLib.txOutValue(own));

        return PriceBetLib.priceAtLeast(oracle, datum.targetRate())
                // A reading that has expired by the end of this transaction is a stale price.
                && PriceBetLib.readingIsFresh(oracle, ContextsLib.txInfoValidRange(tx))
                && PriceBetLib.paidAtLeast(ContextsLib.txInfoOutputs(tx), player, pot)
                && PriceBetLib.endsBefore(ContextsLib.txInfoValidRange(tx), datum.deadline());
    }

    /** Nobody won in time, so the owner reclaims the pot. */
    static boolean timesOut(TxInfo tx, PriceBetLib.PriceBetDatum datum, TxOut own) {
        BigInteger pot = ValuesLib.lovelaceOf(OutputLib.txOutValue(own));

        return PriceBetLib.startsAfter(ContextsLib.txInfoValidRange(tx), datum.deadline())
                && ContextsLib.signedBy(tx, datum.owner())
                && PriceBetLib.paidAtLeast(ContextsLib.txInfoOutputs(tx), datum.owner(), pot);
    }

    /** The oracle is identified by script hash, so only the named oracle can settle this bet. */
    static boolean isOracle(TxInInfo input, byte[] oracleHash) {
        return AddressLib.isScriptAddress(OutputLib.txOutAddress(input.resolved()))
                && ByteStringLib.equals(
                        AddressLib.credentialHash(OutputLib.txOutAddress(input.resolved())),
                        oracleHash);
    }
}
