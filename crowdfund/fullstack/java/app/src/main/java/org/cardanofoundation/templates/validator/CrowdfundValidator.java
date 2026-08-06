package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.core.types.JulcMap;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.Builtins;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.MapLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * An all-or-nothing crowdfund.
 *
 * <p>Donations accumulate in a single script UTxO whose datum is a ledger of who gave what. After
 * the deadline exactly one of two things can happen: the goal was met and the beneficiary takes
 * the pot, or it was not and every donor takes back precisely their own stake.
 *
 * <p>The campaign's terms — beneficiary, goal, deadline — are script parameters, so they are
 * fixed in the address itself. A donor can verify what they are giving to before giving.
 */
@SpendingValidator
public class CrowdfundValidator {

    @Param static byte[] beneficiary;

    @Param static BigInteger goal;

    @Param static BigInteger deadline;

    /**
     * The per-donor ledger.
     *
     * <p>A map keyed by donor, mirroring Aiken's {@code Pairs<VerificationKeyHash, Int>}. It is
     * what makes a failed campaign refundable without trusting anyone: each donor's entitlement
     * is recorded on chain, in the same UTxO that holds the money.
     */
    public record CrowdfundDatum(JulcMap<PlutusData, PlutusData> wallets) {}

    public sealed interface Action permits Donate, Withdraw, Reclaim {}

    public record Donate() implements Action {}

    public record Withdraw() implements Action {}

    public record Reclaim() implements Action {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(CrowdfundDatum datum, Action redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();

        return switch (redeemer) {
            case Donate ignored -> donates(tx, own);
            case Withdraw ignored -> withdraws(tx, own);
            case Reclaim ignored -> reclaims(tx, datum, own);
        };
    }

    /**
     * Giving. The pot must grow, and the ledger must account for every lovelace in it.
     *
     * <p>No deadline check: a late donation harms nobody, because whether the money can be
     * withdrawn or must be refunded is decided entirely by the two rules below.
     *
     * <p>The second rule is the important one. Requiring the ledger to sum to the <em>exact</em>
     * balance stops a donor from writing themselves in for more than they put in — which would
     * otherwise let them reclaim other people's money if the campaign failed.
     */
    static boolean donates(TxInfo tx, TxOut own) {
        JulcList<TxOut> continuing = continuing(tx, own);
        if (continuing.isEmpty()) {
            return false;
        }
        TxOut next = continuing.head();
        CrowdfundDatum updated = (CrowdfundDatum) (Object) OutputLib.getInlineDatum(next);

        BigInteger balance = ValuesLib.lovelaceOf(OutputLib.txOutValue(next));

        return ValuesLib.lovelaceOf(OutputLib.txOutValue(own)).compareTo(balance) < 0
                && total(MapLib.values(updated.wallets())).equals(balance);
    }

    /** The beneficiary collects, but only after the deadline and only if the goal was met. */
    static boolean withdraws(TxInfo tx, TxOut own) {
        return startsAfter(ContextsLib.txInfoValidRange(tx), deadline)
                && ValuesLib.lovelaceOf(OutputLib.txOutValue(own)).compareTo(goal) >= 0
                && ContextsLib.signedBy(tx, beneficiary);
    }

    /**
     * Refunds. Only the donors who signed this transaction are paid, and only what they gave.
     *
     * <p>Several donors can reclaim together, which is why there are two shapes: if the signers'
     * combined contributions are the whole balance they simply drain the UTxO, otherwise they
     * must rebuild it for everyone still owed.
     */
    static boolean reclaims(TxInfo tx, CrowdfundDatum datum, TxOut own) {
        BigInteger owed = owedToSigners(tx, datum.wallets());
        BigInteger balance = ValuesLib.lovelaceOf(OutputLib.txOutValue(own));

        if (!startsAfter(ContextsLib.txInfoValidRange(tx), deadline)) {
            return false;
        }
        if (owed.equals(balance)) {
            // The last reclaimers take what is left. A failed campaign only.
            return balance.compareTo(goal) <= 0;
        }
        JulcList<TxOut> continuing = continuing(tx, own);
        if (continuing.isEmpty()) {
            return false;
        }
        TxOut next = continuing.head();
        CrowdfundDatum updated = (CrowdfundDatum) (Object) OutputLib.getInlineDatum(next);

        // Anti-replay: every signer must be struck from the ledger. Leaving one in would let
        // them come back and reclaim the same contribution again.
        boolean stillListed = ContextsLib.txInfoSignatories(tx)
                .any(signer -> MapLib.member(updated.wallets(), Builtins.bData(signer.hash())));

        return !stillListed
                && balance.compareTo(
                        ValuesLib.lovelaceOf(OutputLib.txOutValue(next)).add(owed)) <= 0
                && balance.compareTo(goal) < 0;
    }

    /**
     * What the signers of this transaction are collectively owed.
     *
     * <p>Walks keys and values side by side. {@code MapLib.lookup} would be the obvious tool, but
     * its {@code Optional} result does not lower from inside a helper.
     */
    static BigInteger owedToSigners(TxInfo tx, JulcMap<PlutusData, PlutusData> wallets) {
        return owedFrom(tx, MapLib.keys(wallets), MapLib.values(wallets));
    }

    static BigInteger owedFrom(TxInfo tx, JulcList<PlutusData> donors,
            JulcList<PlutusData> amounts) {
        if (donors.isEmpty()) {
            return BigInteger.ZERO;
        }
        BigInteger rest = owedFrom(tx, donors.tail(), amounts.tail());

        return ContextsLib.signedBy(tx, Builtins.unBData(donors.head()))
                ? rest.add(Builtins.unIData(amounts.head()))
                : rest;
    }

    static BigInteger total(JulcList<PlutusData> amounts) {
        if (amounts.isEmpty()) {
            return BigInteger.ZERO;
        }
        return Builtins.unIData(amounts.head()).add(total(amounts.tail()));
    }

    static JulcList<TxOut> continuing(TxInfo tx, TxOut own) {
        return ContextsLib.txInfoOutputs(tx)
                .filter(output -> sameAddress(
                        OutputLib.txOutAddress(output), OutputLib.txOutAddress(own)));
    }

    static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }

    /**
     * True when the transaction can only start strictly after {@code point}.
     *
     * <p>Rejects an unbounded lower bound: such a transaction could be included at any time and
     * would say nothing about the deadline having passed.
     */
    static boolean startsAfter(Interval validRange, BigInteger point) {
        return switch (validRange.from().boundType()) {
            case IntervalBoundType.Finite finite ->
                    validRange.from().isInclusive()
                            ? finite.time().compareTo(point) > 0
                            : finite.time().compareTo(point) >= 0;
            case IntervalBoundType.NegInf ignored -> false;
            case IntervalBoundType.PosInf ignored -> false;
        };
    }
}
