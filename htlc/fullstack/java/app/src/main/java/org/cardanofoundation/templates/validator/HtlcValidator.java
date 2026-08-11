package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
import com.bloxbean.cardano.julc.ledger.TxInfo;
import com.bloxbean.cardano.julc.stdlib.annotation.Entrypoint;
import com.bloxbean.cardano.julc.stdlib.annotation.Param;
import com.bloxbean.cardano.julc.stdlib.annotation.Purpose;
import com.bloxbean.cardano.julc.stdlib.annotation.SpendingValidator;
import com.bloxbean.cardano.julc.stdlib.lib.ByteStringLib;
import com.bloxbean.cardano.julc.stdlib.lib.ContextsLib;
import com.bloxbean.cardano.julc.stdlib.lib.CryptoLib;

/**
 * Hash Time-Locked Contract.
 *
 * <p>Funds are locked against a hash and an expiry. Either path can release them:
 * <ul>
 *   <li>{@code Guess} — anyone who reveals a preimage of {@code image} takes the funds.</li>
 *   <li>{@code Withdraw} — the owner reclaims, but only once the expiry has passed.</li>
 * </ul>
 *
 * <p>The hash, expiry and owner are validator <em>parameters</em> rather than datum fields.
 * Each set of values produces its own script hash, so the terms of an HTLC instance are fixed
 * at deploy time and cannot be swapped out by whoever builds the spending transaction.
 */
@SpendingValidator
public class HtlcValidator {

    /** sha2_256 of the secret. Only the digest is ever on-chain before the reveal. */
    @Param
    static byte[] image;

    /** POSIX time in milliseconds. Before this, only a reveal can release the funds. */
    @Param
    static BigInteger expiration;

    /** Verification key hash permitted to reclaim after expiry. */
    @Param
    static byte[] owner;

    public sealed interface Redeemer permits Guess, Withdraw {}

    public record Guess(byte[] answer) implements Redeemer {}

    public record Withdraw() implements Redeemer {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(Redeemer redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);

        return switch (redeemer) {
            // No signature or address constraint: whoever knows the secret may claim.
            // In a cross-chain swap the off-chain protocol decides who learns it.
            case Guess guess -> ByteStringLib.equals(CryptoLib.sha2_256(guess.answer()), image);

            // Refund is gated on time *and* identity, so a reclaim can never race a reveal.
            case Withdraw ignored -> validAfter(ContextsLib.txInfoValidRange(tx), expiration)
                    && ContextsLib.signedBy(tx, owner);
        };
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
