package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.AssetEntry;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.stdlib.annotation.OnchainLibrary;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/** Types and rules shared by the two lottery scripts. */
@OnchainLibrary
public class LotteryLib {

    /**
     * The state of one game.
     *
     * <p>{@code n1} and {@code n2} are empty until revealed. An empty bytestring is used as the
     * sentinel rather than an {@code Option} so the datum stays flat and cheap to compare on
     * chain — and, usefully, "not yet revealed" then has exactly one representation.
     *
     * <p>Declared here because both scripts read it, and a record nested in one validator class
     * is not visible to the other.
     */
    public record LotteryDatum(
            byte[] player1,
            byte[] player2,
            byte[] commit1,
            byte[] commit2,
            byte[] n1,
            byte[] n2,
            BigInteger endReveal,
            BigInteger delta) {}

    public static byte[] tokenName() {
        return "LOTTERY_TOKEN".getBytes();
    }

    public static boolean isEmpty(byte[] bytes) {
        return ByteStringLib.length(bytes) == 0L;
    }

    /** The whole transaction mints exactly one asset, and it is this one at this quantity. */
    public static boolean onlyToken(Value mint, byte[] policyId, BigInteger quantity) {
        JulcList<AssetEntry> minted = ValuesLib.flattenTyped(mint)
                .filter(entry -> ByteStringLib.length(entry.policyId()) > 0L);

        if (minted.size() != 1L) {
            return false;
        }
        AssetEntry entry = minted.head();
        return ByteStringLib.equals(entry.policyId(), policyId)
                && ByteStringLib.equals(entry.tokenName(), tokenName())
                && entry.amount().equals(quantity);
    }

    /**
     * True when the transaction can only be included strictly after {@code deadline}.
     *
     * <p>Matches on the bound directly. {@code IntervalLib.finiteLowerBound} returns −1 for an
     * unbounded lower bound, and comparing that sentinel as if it were a timestamp would treat a
     * transaction that may be included at any time as one that waited.
     */
    public static boolean validAfter(Interval validRange, BigInteger deadline) {
        return switch (validRange.from().boundType()) {
            case IntervalBoundType.Finite finite ->
                    validRange.from().isInclusive()
                            ? finite.time().compareTo(deadline) > 0
                            : finite.time().compareTo(deadline) >= 0;
            case IntervalBoundType.NegInf ignored -> false;
            case IntervalBoundType.PosInf ignored -> false;
        };
    }
}
