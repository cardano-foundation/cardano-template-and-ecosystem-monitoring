package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;

/**
 * Time-locked vesting.
 *
 * <p>The beneficiary can only collect once the lock has elapsed. The owner can reclaim at
 * any time — without that clawback, funds sent to the wrong beneficiary would be stuck
 * forever.
 *
 * <p>The schedule lives in the datum rather than in validator parameters, so one script
 * address hosts many independent vesting schedules.
 */
@SpendingValidator
public class VestingValidator {

    /** {@code lockUntil} is POSIX time in milliseconds, matching Plutus transaction time. */
    public record VestingDatum(BigInteger lockUntil, byte[] owner, byte[] beneficiary) {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(VestingDatum datum, PlutusData redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);

        return ContextsLib.signedBy(tx, datum.owner())
                || (ContextsLib.signedBy(tx, datum.beneficiary())
                        && validAfter(ContextsLib.txInfoValidRange(tx), datum.lockUntil()));
    }

    /**
     * True when the transaction cannot be included before {@code deadline}.
     *
     * <p>Reads the bound directly instead of using {@code IntervalLib.finiteLowerBound}, which
     * reports {@code -1} for an unbounded lower bound. Treating that sentinel as a timestamp
     * would compare a missing bound as if it were a real time. An unbounded lower bound proves
     * nothing about when the transaction runs, so it is rejected.
     */
    static boolean validAfter(Interval validRange, BigInteger deadline) {
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
