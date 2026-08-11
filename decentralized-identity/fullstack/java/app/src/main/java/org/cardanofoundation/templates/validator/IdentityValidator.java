package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.ScriptContext;
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
 * A self-sovereign identity: one UTxO that holds an owner key and a list of time-bounded
 * delegates.
 *
 * <p>The UTxO is a pure state cell. Its value never moves — every transition requires the output
 * to carry exactly what the input carried — so the contract holds no funds and there is nothing
 * to steal. What it holds is <em>authority</em>: an address book that other contracts can consult
 * to decide who may act on this identity's behalf.
 *
 * <p>All three transitions are owner-only, and each one is deliberately narrow: it may change the
 * single thing it names and nothing else. That is what makes the state cell auditable — a reader
 * comparing two consecutive versions can attribute every difference to exactly one action.
 */
@SpendingValidator
public class IdentityValidator {

    public record Delegate(byte[] key, BigInteger expires) {}

    public record IdentityDatum(byte[] owner, JulcList<Delegate> delegates) {}

    public sealed interface Action permits TransferOwner, AddDelegate, RemoveDelegate {}

    public record TransferOwner(byte[] newOwner) implements Action {}

    public record AddDelegate(byte[] delegate, BigInteger expires) implements Action {}

    public record RemoveDelegate(byte[] delegate) implements Action {}

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(IdentityDatum datum, Action redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();

        if (!ContextsLib.signedBy(tx, datum.owner())) {
            return false;
        }

        // Exactly one continuing UTxO. Two would create competing identities sharing an address,
        // each looking equally authentic to anyone reading the chain.
        JulcList<TxOut> continuing = ContextsLib.txInfoOutputs(tx)
                .filter(output -> sameAddress(
                        OutputLib.txOutAddress(output), OutputLib.txOutAddress(own)));

        if (continuing.size() != 1L) {
            return false;
        }
        TxOut next = continuing.head();

        // The identity holds authority, not funds; nothing may be siphoned out under cover of
        // an edit.
        if (!ValuesLib.eq(OutputLib.txOutValue(own), OutputLib.txOutValue(next))) {
            return false;
        }
        IdentityDatum updated = (IdentityDatum) (Object) OutputLib.getInlineDatum(next);

        return switch (redeemer) {
            case TransferOwner action -> transfers(datum, updated, action.newOwner());
            case AddDelegate action -> adds(datum, updated, action, ContextsLib.txInfoValidRange(tx));
            case RemoveDelegate action -> removes(datum, updated, action.delegate());
        };
    }

    /** Rotating the key changes the owner and nothing else — the delegate list carries over. */
    static boolean transfers(IdentityDatum before, IdentityDatum after, byte[] newOwner) {
        return ByteStringLib.equals(after.owner(), newOwner)
                && sameDelegates(before.delegates(), after.delegates());
    }

    /**
     * Adding a delegate appends exactly one entry.
     *
     * <p>Duplicates are refused because a second entry for the same key could outlive the first,
     * silently extending an authority that was meant to lapse. Self-delegation is refused because
     * it is meaningless — the owner already has full authority — and would survive a transfer of
     * ownership as a lingering back door.
     */
    static boolean adds(IdentityDatum before, IdentityDatum after, AddDelegate action,
            Interval validRange) {
        return ByteStringLib.equals(after.owner(), before.owner())
                && !hasDelegate(before.delegates(), action.delegate())
                && hasDelegate(after.delegates(), action.delegate())
                && after.delegates().size() == before.delegates().size() + 1L
                && !ByteStringLib.equals(action.delegate(), before.owner())
                // An expiry already in the past would create authority that was never usable.
                && validBefore(validRange, action.expires());
    }

    /**
     * Removing drops exactly one entry.
     *
     * <p>The length must fall by precisely one, so the owner cannot quietly strip several
     * delegates while appearing to revoke a single named one.
     */
    static boolean removes(IdentityDatum before, IdentityDatum after, byte[] delegate) {
        return ByteStringLib.equals(after.owner(), before.owner())
                && hasDelegate(before.delegates(), delegate)
                && !hasDelegate(after.delegates(), delegate)
                && after.delegates().size() + 1L == before.delegates().size();
    }

    static boolean hasDelegate(JulcList<Delegate> delegates, byte[] key) {
        return delegates.any(d -> ByteStringLib.equals(d.key(), key));
    }

    /** Element-wise: records have no structural equality on chain. */
    static boolean sameDelegates(JulcList<Delegate> a, JulcList<Delegate> b) {
        if (a.size() != b.size()) {
            return false;
        }
        if (a.isEmpty()) {
            return true;
        }
        return ByteStringLib.equals(a.head().key(), b.head().key())
                && a.head().expires().equals(b.head().expires())
                && sameDelegates(a.tail(), b.tail());
    }

    /**
     * True when the transaction can only be included strictly before {@code deadline}.
     *
     * <p>Matches on the bound directly and rejects anything unbounded: a transaction with no
     * upper bound could be included at any time, which would say nothing about the expiry still
     * being in the future.
     */
    static boolean validBefore(Interval validRange, BigInteger deadline) {
        return switch (validRange.to().boundType()) {
            case IntervalBoundType.Finite finite ->
                    validRange.to().isInclusive()
                            ? finite.time().compareTo(deadline) < 0
                            : finite.time().compareTo(deadline) <= 0;
            case IntervalBoundType.NegInf ignored -> false;
            case IntervalBoundType.PosInf ignored -> false;
        };
    }

    static boolean sameAddress(Address a, Address b) {
        return ByteStringLib.equals(AddressLib.credentialHash(a), AddressLib.credentialHash(b));
    }
}
