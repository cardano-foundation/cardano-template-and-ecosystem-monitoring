package org.cardanofoundation.templates.validator;

import java.math.BigInteger;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.core.types.JulcList;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
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
 * An English auction.
 *
 * <p>The item — an NFT — sits at the script address together with the current best bid. Bidding
 * replaces that UTxO with a better one, and settlement after the deadline sends the item to the
 * winner and the money to the seller.
 *
 * <p>The design decision worth noticing is that <b>a losing bidder is refunded in the very
 * transaction that outbids them</b>. There is no queue of stranded deposits and no separate claim
 * step, so nobody has to come back later to recover their money — which is why the
 * {@code Withdraw} branch exists only to be refused.
 */
@MultiValidator
public class AuctionValidator {

    /**
     * {@code highestBidder} is empty until the first bid — a flat sentinel rather than an
     * {@code Option}, so the datum stays cheap to compare on chain.
     */
    public record AuctionDatum(
            byte[] seller,
            byte[] highestBidder,
            BigInteger highestBid,
            BigInteger expiration,
            byte[] assetPolicy,
            byte[] assetName) {}

    public sealed interface Action permits Bid, Withdraw, End {}

    public record Bid() implements Action {}

    public record Withdraw() implements Action {}

    public record End() implements Action {}

    /** Start. Minting the auction token creates the listing. */
    @Entrypoint(purpose = Purpose.MINT)
    static boolean mint(PlutusData redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        byte[] policyId = ContextsLib.ownHash(ctx);

        JulcList<TxOut> listings = ContextsLib.txInfoOutputs(tx)
                .filter(output -> atScript(OutputLib.txOutAddress(output), policyId));

        if (listings.size() != 1L) {
            return false;
        }
        TxOut listing = listings.head();
        AuctionDatum datum = (AuctionDatum) (Object) OutputLib.getInlineDatum(listing);

        return ContextsLib.signedBy(tx, datum.seller())
                && isEmpty(datum.highestBidder())
                && datum.highestBid().compareTo(BigInteger.ZERO) >= 0
                && endsBefore(ContextsLib.txInfoValidRange(tx), datum.expiration())
                // The item must actually be here. A listing without it would take bids for
                // something the contract could never deliver.
                && ValuesLib.containsPolicy(OutputLib.txOutValue(listing), datum.assetPolicy());
    }

    @Entrypoint(purpose = Purpose.SPEND)
    static boolean spend(AuctionDatum datum, Action redeemer, ScriptContext ctx) {
        TxInfo tx = ContextsLib.getTxInfo(ctx);
        TxOut own = ContextsLib.findOwnInput(ctx).get().resolved();

        return switch (redeemer) {
            case Bid ignored -> bids(tx, datum, own);
            case End ignored -> ends(tx, datum, own);
            // Refunds are inline in Bid, so a standalone withdrawal would need per-bidder
            // accounting that this contract deliberately does not keep.
            case Withdraw ignored -> false;
        };
    }

    /** A bid replaces the listing with a strictly better one and pays back whoever it displaces. */
    static boolean bids(TxInfo tx, AuctionDatum datum, TxOut own) {
        JulcList<TxOut> continuing = ContextsLib.txInfoOutputs(tx)
                .filter(output -> sameAddress(
                        OutputLib.txOutAddress(output), OutputLib.txOutAddress(own)));

        if (continuing.size() != 1L) {
            return false;
        }
        TxOut next = continuing.head();
        AuctionDatum updated = (AuctionDatum) (Object) OutputLib.getInlineDatum(next);

        return endsBefore(ContextsLib.txInfoValidRange(tx), datum.expiration())
                && updated.highestBid().compareTo(datum.highestBid()) > 0
                // The new bidder must sign, so nobody can be entered into an auction they never
                // agreed to and have their name attached to a losing bid.
                && ContextsLib.signedBy(tx, updated.highestBidder())
                && ByteStringLib.equals(updated.seller(), datum.seller())
                && ByteStringLib.equals(updated.assetPolicy(), datum.assetPolicy())
                && ByteStringLib.equals(updated.assetName(), datum.assetName())
                && updated.expiration().equals(datum.expiration())
                && ValuesLib.containsPolicy(OutputLib.txOutValue(own), datum.assetPolicy())
                && ValuesLib.containsPolicy(OutputLib.txOutValue(next), datum.assetPolicy())
                && refundsPreviousBidder(tx, datum)
                // Non-decreasing rather than exact: a bidder may leave extra ada behind for the
                // next refund, but may not take any out.
                && ValuesLib.lovelaceOf(OutputLib.txOutValue(next))
                        .compareTo(ValuesLib.lovelaceOf(OutputLib.txOutValue(own))) >= 0;
    }

    /** The displaced bidder gets exactly their stake back, in this same transaction. */
    static boolean refundsPreviousBidder(TxInfo tx, AuctionDatum datum) {
        if (isEmpty(datum.highestBidder())) {
            return true;
        }
        return ContextsLib.txInfoOutputs(tx).any(output ->
                paysDirectly(OutputLib.txOutAddress(output), datum.highestBidder())
                        && ValuesLib.lovelaceOf(OutputLib.txOutValue(output))
                                .equals(datum.highestBid()));
    }

    /**
     * Settlement. The item leaves for exactly one destination and the auction ends.
     *
     * <p>Requiring exactly one output to carry the asset, and none to return to the script, is
     * what makes the ending final: there is no way to split the item's value across destinations
     * or to leave a stale listing behind that could take further bids.
     */
    static boolean ends(TxInfo tx, AuctionDatum datum, TxOut own) {
        JulcList<TxOut> outputs = ContextsLib.txInfoOutputs(tx);

        JulcList<TxOut> withAsset = outputs.filter(output ->
                ValuesLib.containsPolicy(OutputLib.txOutValue(output), datum.assetPolicy()));

        if (withAsset.size() != 1L) {
            return false;
        }
        boolean noContinuing = !outputs.any(output -> sameAddress(
                OutputLib.txOutAddress(output), OutputLib.txOutAddress(own)));

        if (!noContinuing
                || !startsAfter(ContextsLib.txInfoValidRange(tx), datum.expiration())) {
            return false;
        }
        Address itemGoesTo = OutputLib.txOutAddress(withAsset.head());

        if (isEmpty(datum.highestBidder())) {
            // Nobody bid, so the item goes home. The seller signs because this is their choice
            // to make, not a settlement anyone can force.
            return paysDirectly(itemGoesTo, datum.seller())
                    && ContextsLib.signedBy(tx, datum.seller());
        }
        // With a winner the seller's signature is not required: the terms were fixed when the
        // auction was created, and the winner must be able to collect without the seller's
        // cooperation.
        return paysDirectly(itemGoesTo, datum.highestBidder())
                && paidAtLeast(outputs, datum.seller(), datum.highestBid());
    }

    static boolean paidAtLeast(JulcList<TxOut> outputs, byte[] keyHash, BigInteger minLovelace) {
        return outputs.any(output -> paysDirectly(OutputLib.txOutAddress(output), keyHash)
                && ValuesLib.lovelaceOf(OutputLib.txOutValue(output))
                        .compareTo(minLovelace) >= 0);
    }

    static boolean isEmpty(byte[] bytes) {
        return ByteStringLib.length(bytes) == 0L;
    }

    static boolean atScript(Address address, byte[] scriptHash) {
        return AddressLib.isScriptAddress(address)
                && ByteStringLib.equals(AddressLib.credentialHash(address), scriptHash);
    }

    static boolean paysDirectly(Address address, byte[] keyHash) {
        return AddressLib.isPubKeyAddress(address)
                && ByteStringLib.equals(AddressLib.credentialHash(address), keyHash);
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
