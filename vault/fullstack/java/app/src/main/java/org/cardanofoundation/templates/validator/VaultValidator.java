package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
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
import com.bloxbean.cardano.julc.stdlib.lib.OutputLib;
import com.bloxbean.cardano.julc.stdlib.lib.ValuesLib;

/**
 * A time-locked vault with a two-step withdrawal.
 *
 * <p>Taking money out is deliberately slow. The owner first <b>schedules</b> a withdrawal, which
 * stamps the vault with a {@code lockTime} but moves nothing; only after {@code waitTime} has
 * elapsed can they <b>finalize</b> and actually collect. A scheduled withdrawal can also be
 * <b>cancelled</b>.
 *
 * <p>The point is not to protect the owner from themselves — it is that a stolen key is not
 * immediately a stolen balance. A theft becomes visible on chain the moment it is scheduled, and
 * the real owner has the whole cool-down to notice and cancel.
 *
 * <p>{@code waitTime} is a script parameter, so a vault's cool-down is fixed in its address and
 * cannot be shortened by whoever later builds the transaction.
 */
@SpendingValidator
public class VaultValidator {

    @Param static byte[] owner;

    @Param static BigInteger waitTime;

    public record WithdrawDatum(BigInteger lockTime) {}

    public sealed interface Action permits Withdraw, Finalize, Cancel {}

    public record Withdraw() implements Action {}

    public record Finalize() implements Action {}

    public record Cancel() implements Action {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(WithdrawDatum datum, Action redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);

        if (!ContextsLib.signedBy(tx, owner)) {
            return false;
        }
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();

        return switch (redeemer) {
            case Withdraw ignored -> schedules(tx, own);
            case Cancel ignored -> conserves(tx, own);
            // The full cool-down must have elapsed; after that the owner has unconditional access.
            case Finalize ignored -> startsAfter(ContextsLib.txInfoValidRange(tx),
                    waitTime.add(datum.lockTime()));
        };
    }

    /**
     * Scheduling moves nothing: every lovelace stays in the vault, and any newly stamped
     * {@code lockTime} must already be in the past.
     *
     * <p>That second rule is what stops the clock being wound backwards. Without it the owner
     * could wait out most of a cool-down and then re-schedule with an earlier timestamp, making
     * the delay retroactively shorter than the address advertises.
     */
    static boolean schedules(TxInfo tx, TxOut own) {
        if (!conserves(tx, own)) {
            return false;
        }
        Interval validRange = ContextsLib.txInfoValidRange(tx);

        return continuing(tx, own)
                .filter(output -> hasInlineDatum(output))
                .all(output -> startsAfter(validRange, lockTimeOf(output)));
    }

    /** Bound to a local first: a cast-and-accessor chain inside a lambda does not lower. */
    static BigInteger lockTimeOf(TxOut output) {
        WithdrawDatum scheduled = (WithdrawDatum) (Object) OutputLib.getInlineDatum(output);
        return scheduled.lockTime();
    }

    /** Whatever came out of the vault must go straight back into it. */
    static boolean conserves(TxInfo tx, TxOut own) {
        return total(continuing(tx, own))
                .equals(ValuesLib.lovelaceOf(OutputLib.txOutValue(own)));
    }

    static JulcList<TxOut> continuing(TxInfo tx, TxOut own) {
        return ContextsLib.txInfoOutputs(tx)
                .filter(output -> sameAddress(
                        OutputLib.txOutAddress(output), OutputLib.txOutAddress(own)));
    }

    static BigInteger total(JulcList<TxOut> outputs) {
        if (outputs.isEmpty()) {
            return BigInteger.ZERO;
        }
        return ValuesLib.lovelaceOf(OutputLib.txOutValue(outputs.head()))
                .add(total(outputs.tail()));
    }

    static boolean hasInlineDatum(TxOut output) {
        return switch (output.datum()) {
            case OutputDatum.OutputDatumInline ignored -> true;
            case OutputDatum.OutputDatumHash ignored -> false;
            case OutputDatum.NoOutputDatum ignored -> false;
        };
    }

    /**
     * True when the transaction can only be included strictly after {@code deadline}.
     *
     * <p>Rejects an unbounded lower bound: such a transaction could be included at any time, so
     * it would prove nothing about a cool-down having elapsed.
     */
    static boolean startsAfter(Interval validRange, BigInteger deadline) {
        return switch (validRange.from().boundType()) {
            case IntervalBoundType.Finite finite ->
                    validRange.from().isInclusive()
                            ? finite.time().compareTo(deadline) > 0
                            : finite.time().compareTo(deadline) >= 0;
            case IntervalBoundType.NegInf ignored -> false;
            case IntervalBoundType.PosInf ignored -> false;
        };
    }

    static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }
}
