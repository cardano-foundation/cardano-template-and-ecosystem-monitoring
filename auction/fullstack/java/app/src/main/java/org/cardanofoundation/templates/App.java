package org.cardanofoundation.templates;

import java.math.BigInteger;
import java.util.List;

import org.cardanofoundation.templates.validator.AuctionValidator;
import org.cardanofoundation.templates.validator.ItemPolicy;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.address.AddressProvider;
import com.bloxbean.cardano.client.api.UtxoSupplier;
import com.bloxbean.cardano.client.api.model.Amount;
import com.bloxbean.cardano.client.api.model.Utxo;
import com.bloxbean.cardano.client.backend.api.BackendService;
import com.bloxbean.cardano.client.backend.api.DefaultUtxoSupplier;
import com.bloxbean.cardano.client.backend.blockfrost.service.BFBackendService;
import com.bloxbean.cardano.client.common.model.Network;
import com.bloxbean.cardano.client.common.model.Networks;
import com.bloxbean.cardano.client.function.helper.SignerProviders;
import com.bloxbean.cardano.client.plutus.spec.BigIntPlutusData;
import com.bloxbean.cardano.client.plutus.spec.BytesPlutusData;
import com.bloxbean.cardano.client.plutus.spec.ConstrPlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusData;
import com.bloxbean.cardano.client.plutus.spec.PlutusScript;
import com.bloxbean.cardano.client.quicktx.QuickTxBuilder;
import com.bloxbean.cardano.client.quicktx.ScriptTx;
import com.bloxbean.cardano.client.quicktx.Tx;
import com.bloxbean.cardano.client.quicktx.TxResult;
import com.bloxbean.cardano.client.transaction.spec.Asset;
import com.bloxbean.cardano.client.util.HexUtil;
import com.bloxbean.cardano.julc.clientlib.JulcScriptLoader;

/**
 * An English auction.
 *
 * <p>The item sits at the script address with the current best bid. Bidding replaces that UTxO
 * with a better one; settlement after the deadline sends the item to the winner and the money to
 * the seller.
 *
 * <p>The property this example is built to demonstrate is that <b>a losing bidder is refunded in
 * the very transaction that outbids them</b>. There is no queue of stranded deposits and no claim
 * step to remember — which is also why the contract's {@code Withdraw} branch exists only to be
 * refused.
 *
 * <p>Run it against a local Yaci DevKit:
 * <pre>./gradlew run</pre>
 */
public class App {

    /** Yaci DevKit's Blockfrost-compatible API. Override when the devkit is not on :8080. */
    private static final String BACKEND_URL =
            envOrDefault("CARDANO_BACKEND_URL", "http://localhost:8080/api/v1/");

    /** The devkit's pre-funded account. */
    private static final String MNEMONIC = "test test test test test test test test test test "
            + "test test test test test test test test test test test test test sauce";

    private static final Network NETWORK = Networks.testnet();

    private static final Account SELLER = Account.createFromMnemonic(NETWORK, MNEMONIC);
    private static final Account ALICE = new Account(NETWORK);
    private static final Account BOB = new Account(NETWORK);

    private static final BackendService BACKEND = new BFBackendService(BACKEND_URL, "Dummy Key");
    private static final QuickTxBuilder TX_BUILDER = new QuickTxBuilder(BACKEND);
    private static final UtxoSupplier UTXOS = new DefaultUtxoSupplier(BACKEND.getUtxoService());

    private static final BigInteger LISTING_ADA = BigInteger.valueOf(3_000_000);
    private static final BigInteger FIRST_BID = BigInteger.valueOf(8_000_000);
    private static final BigInteger BETTER_BID = BigInteger.valueOf(12_000_000);

    /**
     * A deadline far enough out that every bid lands inside it.
     *
     * <p>Settlement is not attempted after a real wait: this devnet reports a block's
     * {@code slot} and its {@code time} out of step with each other, so a deadline derived from
     * block time is not reliably comparable against a slot-derived bound. The {@code End} branch
     * is covered instead by the unit tests, which drive the same compiled validator with exact
     * validity ranges. What the on-chain run proves is the bidding and refund behaviour.
     */
    private static final long BIDDING_WINDOW_SECONDS = 86_400;

    private static PlutusScript auction;
    private static String auctionAddress;
    private static PlutusScript itemPolicy;
    private static String itemName;

    public static void main(String[] args) throws Exception {
        auction = JulcScriptLoader.load(AuctionValidator.class);
        auctionAddress = AddressProvider.getEntAddress(auction, NETWORK).toBech32();

        itemName = "PAINTING" + System.currentTimeMillis();
        itemPolicy = JulcScriptLoader.load(ItemPolicy.class,
                BytesPlutusData.of(keyHash(SELLER)));

        BigInteger deadline = BigInteger.valueOf(
                (chainTimeSeconds() + BIDDING_WINDOW_SECONDS) * 1000L);

        System.out.println("Auction address: " + auctionAddress);
        System.out.println("Item policy:     " + itemPolicy.getPolicyId());
        System.out.println("Alice:           " + ALICE.baseAddress());
        System.out.println("Bob:             " + BOB.baseAddress());

        fund(ALICE, 40_000_000);
        fund(BOB, 40_000_000);

        // 1. The seller lists the item. Minting the auction token creates the listing.
        Utxo listing = start(deadline);
        System.out.println("Auction started in " + listing.getTxHash());

        // 2. Alice opens the bidding.
        Utxo afterAlice = utxoOf(succeed(
                bid(listing, ALICE, FIRST_BID, deadline, null, BigInteger.ZERO),
                "Alice's bid"));
        System.out.println("Alice bid in " + afterAlice.getTxHash());

        // 3. Bob cannot displace her without paying her back — this is the promise the whole
        //    design rests on.
        require(isRejected(() -> bid(afterAlice, BOB, BETTER_BID, deadline, null,
                        BigInteger.ZERO)),
                "outbidding without refunding the previous bidder must be rejected");
        System.out.println("Outbid without refund rejected as expected");

        // 4. Nor by refunding less than she staked.
        require(isRejected(() -> bid(afterAlice, BOB, BETTER_BID, deadline, ALICE,
                        FIRST_BID.subtract(BigInteger.valueOf(1_000_000)))),
                "a partial refund must be rejected");
        System.out.println("Partial refund rejected as expected");

        // 5. A lower bid is not a bid.
        require(isRejected(() -> bid(afterAlice, BOB, FIRST_BID, deadline, ALICE, FIRST_BID)),
                "a bid that does not exceed the current one must be rejected");
        System.out.println("Non-increasing bid rejected as expected");

        // 6. Bob outbids properly, refunding Alice in the same transaction.
        TxResult outbid = succeed(
                bid(afterAlice, BOB, BETTER_BID, deadline, ALICE, FIRST_BID), "Bob's bid");
        System.out.println("Bob outbid Alice in " + outbid.getTxHash());

        require(spendsAuction(outbid.getTxHash()),
                "the confirmed transaction must spend the auction UTxO");
        require(refunded(outbid.getTxHash(), ALICE.baseAddress(), FIRST_BID),
                "Alice must be refunded her full bid in that same transaction");

        System.out.println("Verified: the displaced bidder was repaid by the bid that displaced her");
    }

    // ── Transactions ──────────────────────────────────────────────────────────────────

    private static void fund(Account account, long lovelace) throws Exception {
        Tx fund = new Tx()
                .payToAddress(account.baseAddress(), Amount.lovelace(BigInteger.valueOf(lovelace)))
                .from(SELLER.baseAddress());

        succeed(TX_BUILDER.compose(fund)
                .withSigner(SignerProviders.signerFrom(SELLER))
                .completeAndWait(), "funding");
    }

    /** Mints the item and the auction token together, creating the listing. */
    private static Utxo start(BigInteger deadline) throws Exception {
        Asset item = Asset.builder().name(itemName).value(BigInteger.ONE).build();

        ScriptTx startTx = new ScriptTx()
                .mintAsset(itemPolicy, List.of(item), PlutusData.unit())
                .mintAsset(auction, List.of(
                        Asset.builder().name("AUCTION").value(BigInteger.ONE).build()),
                        PlutusData.unit())
                .payToContract(auctionAddress,
                        List.of(Amount.lovelace(LISTING_ADA),
                                Amount.asset(itemPolicy.getPolicyId(), itemName, BigInteger.ONE),
                                Amount.asset(auction.getPolicyId(), "AUCTION", BigInteger.ONE)),
                        datum(new byte[0], BigInteger.ZERO, deadline))
                .withChangeAddress(SELLER.baseAddress());

        TxResult result = TX_BUILDER.compose(startTx)
                .feePayer(SELLER.baseAddress())
                .withSigner(SignerProviders.signerFrom(SELLER))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        SELLER.baseAddress()))
                .validTo(soon())
                .completeAndWait();

        return utxoOf(succeed(result, "starting the auction"));
    }

    /**
     * Places a bid, rebuilding the listing with the new best offer.
     *
     * <p>{@code refundTo} and {@code refundAmount} are what the rejection cases bend — passing no
     * refund, or too small a one, is exactly what the contract must catch.
     */
    private static TxResult bid(Utxo listing, Account bidder, BigInteger amount,
            BigInteger deadline, Account refundTo, BigInteger refundAmount) throws Exception {
        ScriptTx bidTx = new ScriptTx()
                // Bid is constructor 0 of Action.
                .collectFrom(listing, ConstrPlutusData.of(0))
                .attachSpendingValidator(auction)
                .payToContract(auctionAddress,
                        List.of(Amount.lovelace(amount),
                                Amount.asset(itemPolicy.getPolicyId(), itemName, BigInteger.ONE),
                                Amount.asset(auction.getPolicyId(), "AUCTION", BigInteger.ONE)),
                        datum(keyHash(bidder), amount, deadline));

        if (refundTo != null) {
            bidTx = bidTx.payToAddress(refundTo.baseAddress(), Amount.lovelace(refundAmount));
        }
        bidTx = bidTx.withChangeAddress(bidder.baseAddress());

        return TX_BUILDER.compose(bidTx)
                .feePayer(bidder.baseAddress())
                .withSigner(SignerProviders.signerFrom(bidder))
                .withRequiredSigners(new com.bloxbean.cardano.client.address.Address(
                        bidder.baseAddress()))
                .validTo(soon())
                .completeAndWait();
    }

    // ── On-chain data ─────────────────────────────────────────────────────────────────

    /**
     * {@code AuctionDatum { seller, highestBidder, highestBid, expiration, policy, name }}.
     *
     * <p>An empty {@code highestBidder} means no bids yet.
     */
    private static PlutusData datum(byte[] bidder, BigInteger bid, BigInteger deadline)
            throws Exception {
        return ConstrPlutusData.of(0,
                BytesPlutusData.of(keyHash(SELLER)),
                BytesPlutusData.of(bidder),
                BigIntPlutusData.of(bid),
                BigIntPlutusData.of(deadline),
                BytesPlutusData.of(HexUtil.decodeHexString(itemPolicy.getPolicyId())),
                BytesPlutusData.of(itemName.getBytes()));
    }

    // ── Verification ──────────────────────────────────────────────────────────────────

    /**
     * Fail-closed proof that the validator ran: the confirmed transaction must list an input at
     * the auction address. Checking that a UTxO merely disappeared would pass by accident
     * whenever the lookup itself failed.
     */
    private static boolean spendsAuction(String txHash) throws Exception {
        return await(txHash, utxos -> utxos.getInputs().stream()
                .anyMatch(input -> auctionAddress.equals(input.getAddress())));
    }

    /** The displaced bidder's refund really landed, in this same transaction. */
    private static boolean refunded(String txHash, String address, BigInteger expected)
            throws Exception {
        return await(txHash, utxos -> utxos.getOutputs().stream()
                .filter(output -> address.equals(output.getAddress()))
                .flatMap(output -> output.getAmount().stream())
                .filter(amount -> "lovelace".equals(amount.getUnit()))
                // The backend model reports quantities as strings.
                .anyMatch(amount -> expected.equals(new BigInteger(amount.getQuantity()))));
    }

    /** Polls, because a node confirms a transaction slightly before the indexer serves it. */
    private static boolean await(String txHash, TxCheck check) throws Exception {
        for (int attempt = 0; attempt < 10; attempt++) {
            try {
                var response = BACKEND.getTransactionService().getTransactionUtxos(txHash);
                if (response.isSuccessful()) {
                    return check.test(response.getValue());
                }
            } catch (Exception notIndexedYet) {
                // fall through and retry
            }
            Thread.sleep(2_000);
        }
        throw new IllegalStateException("transaction " + txHash + " never became readable");
    }

    @FunctionalInterface
    private interface TxCheck {
        boolean test(com.bloxbean.cardano.client.backend.model.TxContentUtxo utxos);
    }

    /**
     * Reports whether the chain refused a transaction.
     *
     * <p>Cardano evaluates scripts before a transaction can be submitted, so a validator that
     * says no surfaces while the client is still building — as an exception rather than a failed
     * result. Both outcomes count as a rejection.
     */
    private static boolean isRejected(Attempt attempt) {
        try {
            return !attempt.run().isSuccessful();
        } catch (Exception rejected) {
            System.out.println("  rejected: " + shortMessage(rejected));
            return true;
        }
    }

    @FunctionalInterface
    private interface Attempt {
        TxResult run() throws Exception;
    }

    private static String shortMessage(Exception e) {
        String message = String.valueOf(e.getMessage());
        return message.length() > 120 ? message.substring(0, 120) + "…" : message;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────

    private static TxResult succeed(TxResult result, String what) {
        require(result.isSuccessful(), what + " failed: " + result);
        return result;
    }

    private static long chainTimeSeconds() throws Exception {
        return BACKEND.getBlockService().getLatestBlock().getValue().getTime();
    }

    private static long soon() throws Exception {
        return BACKEND.getBlockService().getLatestBlock().getValue().getSlot() + 600;
    }

    /**
     * Matches on this transaction's hash: a devnet is long-lived, so taking the first UTxO at the
     * auction address would pick up listings left by an earlier run.
     */
    private static Utxo utxoOf(TxResult result) throws Exception {
        return UTXOS.getAll(auctionAddress).stream()
                .filter(utxo -> utxo.getTxHash().equals(result.getTxHash()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException(
                        "no auction UTxO created by " + result.getTxHash()));
    }

    private static byte[] keyHash(Account account) {
        return account.getBaseAddress().getPaymentCredentialHash()
                .orElseThrow(() -> new IllegalStateException("account has no payment credential"));
    }

    /** The exit code is the result, so every check throws rather than printing a warning. */
    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalStateException(message);
        }
    }

    private static String envOrDefault(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
