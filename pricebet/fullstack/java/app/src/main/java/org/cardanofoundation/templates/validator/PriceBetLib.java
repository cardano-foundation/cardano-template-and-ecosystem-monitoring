package org.cardanofoundation.templates.validator;

import java.math.BigInteger;
import java.util.Optional;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.core.types.JulcMap;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.stdlib.annotation.OnchainLibrary;
import com.bloxbean.cardano.julc.stdlib.Builtins;
import com.bloxbean.cardano.julc.stdlib.lib.AddressLib;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.MapLib;
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/** Types and rules shared by the bet and the oracle it consults. */
@OnchainLibrary
public class PriceBetLib {

    /**
     * The bet's state. {@code player} is empty until someone takes the other side.
     *
     * <p>{@code oracleHash} pins which oracle this bet trusts. It is part of the datum rather
     * than a script parameter so the address stays the same across bets, but it is fixed at
     * creation and every transition carries it over unchanged — a bet cannot be re-pointed at a
     * friendlier oracle after the fact.
     */
    public record PriceBetDatum(
            byte[] owner,
            Optional<byte[]> player,
            byte[] oracleHash,
            BigInteger targetRate,
            BigInteger deadline,
            BigInteger betAmount) {}

    public sealed interface PriceData permits SharedData, ExtendedData, GenericData {}

    public record SharedData() implements PriceData {}

    public record ExtendedData() implements PriceData {}

    /** Keys: 0 = price, 1 = timestamp, 2 = expiry. */
    public record GenericData(JulcMap<PlutusData, PlutusData> priceMap) implements PriceData {}

    public record OracleDatum(PriceData priceData) {}

    /**
     * True when the oracle's price is at or above {@code target}.
     *
     * <p>The other {@code PriceData} variants carry no price, so they answer {@code false}. This
     * is stated as a predicate rather than a "read the price" getter on purpose: a getter would
     * have to invent a number for those variants, and any number it invented would silently be
     * treated as a real reading.
     */
    public static boolean priceAtLeast(OracleDatum oracle, BigInteger target) {
        return switch (oracle.priceData()) {
            case GenericData generic -> lookup(generic, BigInteger.ZERO).compareTo(target) >= 0;
            case SharedData ignored -> false;
            case ExtendedData ignored -> false;
        };
    }

    /** True when the reading is still unexpired for the whole of this transaction. */
    public static boolean readingIsFresh(OracleDatum oracle, Interval validRange) {
        return switch (oracle.priceData()) {
            case GenericData generic -> endsBefore(validRange, lookup(generic, BigInteger.TWO));
            case SharedData ignored -> false;
            case ExtendedData ignored -> false;
        };
    }

    /**
     * Keys: 0 = price, 1 = timestamp, 2 = expiry.
     *
     * <p>Walks the pairs directly rather than going through {@code MapLib.lookup}, whose
     * {@code Optional} result does not lower from this depth. A missing key falls off the end of
     * the list and aborts, which is the intended behaviour — defaulting to a number here would
     * turn a malformed oracle into a silently wrong price.
     */
    public static BigInteger lookup(GenericData data, BigInteger key) {
        JulcList<PlutusData> keys = MapLib.keys(data.priceMap());
        JulcList<PlutusData> values = MapLib.values(data.priceMap());
        return Builtins.unIData(values.get(indexOf(keys, key, 0L)));
    }

    public static long indexOf(JulcList<PlutusData> keys, BigInteger key, long index) {
        return Builtins.unIData(keys.head()).equals(key)
                ? index
                : indexOf(keys.tail(), key, index + 1L);
    }

    /**
     * True when the transaction is bounded above by {@code deadline} — it must happen entirely
     * before it, not merely start before it.
     *
     * <p>An unbounded upper bound is refused: such a transaction could be included at any time,
     * so it would say nothing about a deadline.
     */
    public static boolean endsBefore(Interval validRange, BigInteger deadline) {
        return switch (validRange.to().boundType()) {
            case IntervalBoundType.Finite finite -> finite.time().compareTo(deadline) <= 0;
            case IntervalBoundType.NegInf ignored -> false;
            case IntervalBoundType.PosInf ignored -> false;
        };
    }

    /**
     * True when the transaction can only start strictly after {@code deadline}.
     *
     * <p>Strict, so a settlement and a timeout can never both be valid in the same slot.
     */
    public static boolean startsAfter(Interval validRange, BigInteger deadline) {
        return switch (validRange.from().boundType()) {
            case IntervalBoundType.Finite finite -> finite.time().compareTo(deadline) > 0;
            case IntervalBoundType.NegInf ignored -> false;
            case IntervalBoundType.PosInf ignored -> false;
        };
    }

    /** Some output pays {@code keyHash} at least {@code minLovelace}. */
    public static boolean paidAtLeast(JulcList<TxOut> outputs, byte[] keyHash,
            BigInteger minLovelace) {
        return outputs.any(output ->
                ByteStringLib.equals(
                        AddressLib.credentialHash(OutputLib.txOutAddress(output)), keyHash)
                        && ValuesLib.lovelaceOf(OutputLib.txOutValue(output))
                                .compareTo(minLovelace) >= 0);
    }

    public static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }
}
