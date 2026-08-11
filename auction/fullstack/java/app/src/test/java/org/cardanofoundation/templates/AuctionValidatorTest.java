package org.cardanofoundation.templates;

import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.bytesData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.constrData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.intData;
import static com.bloxbean.cardano.julc.testkit.TestDataBuilder.unitData;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

import org.cardanofoundation.templates.validator.AuctionValidator;
import org.junit.jupiter.api.Test;

import com.bloxbean.cardano.julc.core.PlutusData;
import com.bloxbean.cardano.julc.ledger.Address;
import com.bloxbean.cardano.julc.ledger.Credential;
import com.bloxbean.cardano.julc.ledger.Interval;
import com.bloxbean.cardano.julc.ledger.IntervalBound;
import com.bloxbean.cardano.julc.ledger.IntervalBoundType;
import com.bloxbean.cardano.julc.ledger.OutputDatum;
import com.bloxbean.cardano.julc.ledger.PolicyId;
import com.bloxbean.cardano.julc.ledger.PubKeyHash;
import com.bloxbean.cardano.julc.ledger.ScriptHash;
import com.bloxbean.cardano.julc.ledger.TokenName;
import com.bloxbean.cardano.julc.ledger.TxId;
import com.bloxbean.cardano.julc.ledger.TxInInfo;
import com.bloxbean.cardano.julc.ledger.TxOut;
import com.bloxbean.cardano.julc.ledger.TxOutRef;
import com.bloxbean.cardano.julc.ledger.Value;
import com.bloxbean.cardano.julc.testkit.JulcEval;
import com.bloxbean.cardano.julc.testkit.ScriptContextTestBuilder;

/**
 * Runs the compiled multi-validator on a real Plutus VM.
 *
 * <p>An auction has two properties worth defending, and the tests are organised around them: a
 * losing bidder must always get their money back in the very transaction that displaces them,
 * and once the deadline passes the item must land in exactly one place.
 */
class AuctionValidatorTest {

    /** The script hash doubles as the auction token's policy id, as for any multi-validator. */
    private static final byte[] SCRIPT_HASH = fill((byte) 0x07, 28);
    private static final Address SCRIPT = new Address(
            new Credential.ScriptCredential(new ScriptHash(SCRIPT_HASH)), Optional.empty());

    private static final byte[] SELLER = fill((byte) 0x01, 28);
    private static final byte[] ALICE = fill((byte) 0x02, 28);
    private static final byte[] BOB = fill((byte) 0x03, 28);

    private static final byte[] ITEM_POLICY = fill((byte) 0x0B, 28);
    private static final byte[] ITEM_NAME = "PAINTING".getBytes();
    private static final byte[] EMPTY = new byte[0];

    private static final BigInteger DEADLINE = BigInteger.valueOf(1_000_000);
    private static final BigInteger FIRST_BID = BigInteger.valueOf(5_000_000);
    private static final BigInteger BETTER_BID = BigInteger.valueOf(8_000_000);

    private static final TxOutRef REF =
            new TxOutRef(new TxId(fill((byte) 0xAA, 32)), BigInteger.ZERO);

    private final JulcEval eval = JulcEval.forClass(AuctionValidator.class);

    // ── Starting ──────────────────────────────────────────────────────────────────────

    @Test
    void sellerStartsAnAuction() {
        assertTrue(start(datum(EMPTY, BigInteger.ZERO), SELLER, true, before()));
    }

    @Test
    void startMustBeSignedByTheSeller() {
        assertFalse(start(datum(EMPTY, BigInteger.ZERO), ALICE, true, before()));
    }

    /** A listing without the item would take bids for something it can never deliver. */
    @Test
    void startRequiresTheItemToBePresent() {
        assertFalse(start(datum(EMPTY, BigInteger.ZERO), SELLER, false, before()));
    }

    /** Naming a bidder up front would enter someone into an auction they never agreed to. */
    @Test
    void startCannotPreFillABidder() {
        assertFalse(start(datum(ALICE, FIRST_BID), SELLER, true, before()));
    }

    @Test
    void cannotStartAnAuctionThatHasAlreadyExpired() {
        assertFalse(start(datum(EMPTY, BigInteger.ZERO), SELLER, true, after(DEADLINE)));
    }

    // ── Bidding ───────────────────────────────────────────────────────────────────────

    /** There is nobody to refund yet, so the refund rule must not fire spuriously. */
    @Test
    void firstBidNeedsNoRefund() {
        assertTrue(bid(open(), datum(ALICE, FIRST_BID), FIRST_BID, ALICE, before(), noRefund(),
                true));
    }

    @Test
    void outbiddingRefundsThePreviousBidder() {
        assertTrue(bid(taken(), datum(BOB, BETTER_BID), BETTER_BID, BOB, before(),
                refund(ALICE, FIRST_BID)));
    }

    /** The whole no-stranded-deposits promise rests on this. */
    @Test
    void outbiddingWithoutRefundingIsRejected() {
        assertFalse(bid(taken(), datum(BOB, BETTER_BID), BETTER_BID, BOB, before(), noRefund()));
    }

    /** A partial refund is not a refund. */
    @Test
    void refundMustBeTheFullPreviousBid() {
        assertFalse(bid(taken(), datum(BOB, BETTER_BID), BETTER_BID, BOB, before(),
                refund(ALICE, FIRST_BID.subtract(BigInteger.ONE))));
        assertFalse(bid(taken(), datum(BOB, BETTER_BID), BETTER_BID, BOB, before(),
                refund(BOB, FIRST_BID)));
    }

    @Test
    void bidMustBeStrictlyHigher() {
        assertFalse(bid(taken(), datum(BOB, FIRST_BID), FIRST_BID, BOB, before(),
                refund(ALICE, FIRST_BID)));
    }

    @Test
    void bidMustBeSignedByTheBidder() {
        assertFalse(bid(taken(), datum(BOB, BETTER_BID), BETTER_BID, ALICE, before(),
                refund(ALICE, FIRST_BID)));
    }

    @Test
    void biddingCannotChangeTheTerms() {
        PlutusData movedDeadline = new DatumBuilder().bidder(BOB).bid(BETTER_BID)
                .expiration(DEADLINE.multiply(BigInteger.TWO)).build();
        assertFalse(bid(taken(), movedDeadline, BETTER_BID, BOB, before(),
                refund(ALICE, FIRST_BID)));

        PlutusData movedSeller = new DatumBuilder().bidder(BOB).bid(BETTER_BID)
                .seller(BOB).build();
        assertFalse(bid(taken(), movedSeller, BETTER_BID, BOB, before(),
                refund(ALICE, FIRST_BID)));
    }

    /** A bidder may leave extra ada for the next refund, but may not take any out. */
    @Test
    void biddingCannotDrainTheListing() {
        assertFalse(bid(taken(), datum(BOB, BETTER_BID),
                FIRST_BID.subtract(BigInteger.ONE), BOB, before(), refund(ALICE, FIRST_BID)));
    }

    @Test
    void cannotBidAfterTheDeadline() {
        assertFalse(bid(taken(), datum(BOB, BETTER_BID), BETTER_BID, BOB, after(DEADLINE),
                refund(ALICE, FIRST_BID)));
    }

    // ── Withdrawing ───────────────────────────────────────────────────────────────────

    /** Refunds are inline in Bid, so this branch exists only to be refused. */
    @Test
    void withdrawIsAlwaysRefused() {
        PlutusData ctx = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, listing(taken(), FIRST_BID, true)))
                .signer(new PubKeyHash(ALICE))
                .validRange(before())
                .buildPlutusData();
        assertFalse(eval.call("spend", taken(), constrData(1), ctx).asBoolean());
    }

    // ── Ending ────────────────────────────────────────────────────────────────────────

    @Test
    void winnerTakesTheItemAndSellerIsPaid() {
        assertTrue(end(taken(), after(DEADLINE), List.of(
                item(ALICE), pay(SELLER, FIRST_BID)), ALICE));
    }

    /** The seller must actually be paid, not merely named in the datum. */
    @Test
    void endMustPayTheSeller() {
        assertFalse(end(taken(), after(DEADLINE), List.of(
                item(ALICE), pay(SELLER, FIRST_BID.subtract(BigInteger.ONE))), ALICE));
    }

    @Test
    void itemMustGoToTheWinner() {
        assertFalse(end(taken(), after(DEADLINE), List.of(
                item(BOB), pay(SELLER, FIRST_BID)), ALICE));
    }

    @Test
    void cannotEndBeforeTheDeadline() {
        assertFalse(end(taken(), before(), List.of(
                item(ALICE), pay(SELLER, FIRST_BID)), ALICE));
    }

    /** A stale listing left behind could keep taking bids after settlement. */
    @Test
    void endCannotLeaveTheListingBehind() {
        List<TxOut> outputs = new ArrayList<>(List.of(item(ALICE), pay(SELLER, FIRST_BID)));
        outputs.add(listing(taken(), FIRST_BID, false));
        assertFalse(end(taken(), after(DEADLINE), outputs, ALICE));
    }

    /** Splitting the asset across destinations would make "who won" ambiguous. */
    @Test
    void endRejectsTheItemLandingInTwoPlaces() {
        assertFalse(end(taken(), after(DEADLINE), List.of(
                item(ALICE), item(BOB), pay(SELLER, FIRST_BID)), ALICE));
    }

    @Test
    void unsoldItemReturnsToTheSeller() {
        assertTrue(end(open(), after(DEADLINE), List.of(item(SELLER)), SELLER));
    }

    @Test
    void unsoldItemCannotBeTakenBySomeoneElse() {
        assertFalse(end(open(), after(DEADLINE), List.of(item(ALICE)), ALICE));
    }

    @Test
    void returningAnUnsoldItemNeedsTheSellersSignature() {
        assertFalse(end(open(), after(DEADLINE), List.of(item(SELLER)), ALICE));
    }

    // ── Harness ───────────────────────────────────────────────────────────────────────

    private boolean start(PlutusData datum, byte[] signer, boolean withItem, Interval range) {
        PlutusData ctx = ScriptContextTestBuilder.minting(PolicyId.of(SCRIPT_HASH))
                .output(listing(datum, BigInteger.valueOf(2_000_000), withItem))
                .signer(new PubKeyHash(signer))
                .validRange(range)
                .buildPlutusData();
        return eval.call("mint", unitData(), ctx).asBoolean();
    }

    private boolean bid(PlutusData before, PlutusData after, BigInteger locked, byte[] signer,
            Interval range, List<TxOut> extra) {
        return bid(before, after, locked, signer, range, extra, false);
    }

    private boolean bid(PlutusData before, PlutusData after, BigInteger locked, byte[] signer,
            Interval range, List<TxOut> extra, boolean fromOpen) {
        BigInteger held = fromOpen ? BigInteger.valueOf(2_000_000) : FIRST_BID;

        ScriptContextTestBuilder builder = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, listing(before, held, true)))
                .output(listing(after, locked, true))
                .signer(new PubKeyHash(signer))
                .validRange(range);

        for (TxOut output : extra) {
            builder = builder.output(output);
        }
        // Bid is constructor 0 of Action.
        return eval.call("spend", before, constrData(0), builder.buildPlutusData()).asBoolean();
    }

    private boolean end(PlutusData datum, Interval range, List<TxOut> outputs, byte[] signer) {
        ScriptContextTestBuilder builder = ScriptContextTestBuilder.spending(REF)
                .input(new TxInInfo(REF, listing(datum, FIRST_BID, true)))
                .signer(new PubKeyHash(signer))
                .validRange(range);

        for (TxOut output : outputs) {
            builder = builder.output(output);
        }
        // End is constructor 2 of Action.
        return eval.call("spend", datum, constrData(2), builder.buildPlutusData()).asBoolean();
    }

    // ── Fixtures ──────────────────────────────────────────────────────────────────────

    private static PlutusData open() {
        return datum(EMPTY, BigInteger.ZERO);
    }

    private static PlutusData taken() {
        return datum(ALICE, FIRST_BID);
    }

    private static PlutusData datum(byte[] bidder, BigInteger bid) {
        return new DatumBuilder().bidder(bidder).bid(bid).build();
    }

    /** {@code AuctionDatum { seller, highestBidder, highestBid, expiration, policy, name }}. */
    private static final class DatumBuilder {
        private byte[] seller = SELLER;
        private byte[] bidder = EMPTY;
        private BigInteger bid = BigInteger.ZERO;
        private BigInteger expiration = DEADLINE;

        DatumBuilder seller(byte[] s) { seller = s; return this; }
        DatumBuilder bidder(byte[] b) { bidder = b; return this; }
        DatumBuilder bid(BigInteger b) { bid = b; return this; }
        DatumBuilder expiration(BigInteger e) { expiration = e; return this; }

        PlutusData build() {
            return constrData(0, bytesData(seller), bytesData(bidder), intData(bid),
                    intData(expiration), bytesData(ITEM_POLICY), bytesData(ITEM_NAME));
        }
    }

    private static TxOut listing(PlutusData datum, BigInteger lovelace, boolean withItem) {
        Value value = withItem
                ? Value.lovelace(lovelace).merge(itemValue())
                : Value.lovelace(lovelace);
        return new TxOut(SCRIPT, value, new OutputDatum.OutputDatumInline(datum),
                Optional.empty());
    }

    private static TxOut item(byte[] keyHash) {
        return new TxOut(wallet(keyHash),
                itemValue().merge(Value.lovelace(BigInteger.valueOf(2_000_000))),
                new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static TxOut pay(byte[] keyHash, BigInteger lovelace) {
        return new TxOut(wallet(keyHash), Value.lovelace(lovelace),
                new OutputDatum.NoOutputDatum(), Optional.empty());
    }

    private static List<TxOut> refund(byte[] keyHash, BigInteger lovelace) {
        return List.of(pay(keyHash, lovelace));
    }

    private static List<TxOut> noRefund() {
        return List.of();
    }

    private static Value itemValue() {
        return Value.singleton(PolicyId.of(ITEM_POLICY), new TokenName(ITEM_NAME),
                BigInteger.ONE);
    }

    private static Address wallet(byte[] keyHash) {
        return new Address(new Credential.PubKeyCredential(new PubKeyHash(keyHash)),
                Optional.empty());
    }

    /** A transaction that must be included before the deadline. */
    private static Interval before() {
        return new Interval(
                new IntervalBound(new IntervalBoundType.NegInf(), true),
                new IntervalBound(new IntervalBoundType.Finite(
                        DEADLINE.subtract(BigInteger.ONE)), true));
    }

    /** A transaction that cannot start until after {@code from}. */
    private static Interval after(BigInteger from) {
        return new Interval(
                new IntervalBound(new IntervalBoundType.Finite(from.add(BigInteger.ONE)), true),
                new IntervalBound(new IntervalBoundType.PosInf(), true));
    }

    private static byte[] fill(byte value, int length) {
        byte[] bytes = new byte[length];
        Arrays.fill(bytes, value);
        return bytes;
    }
}
