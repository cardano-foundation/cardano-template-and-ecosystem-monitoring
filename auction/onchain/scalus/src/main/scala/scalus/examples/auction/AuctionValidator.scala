package scalus.examples.auction

import scalus.Compile
import scalus.builtin.*
import scalus.builtin.Data
import scalus.builtin.Data.FromData
import scalus.builtin.Data.ToData
import scalus.builtin.ToData.*
import scalus.ledger.api.v1.Credential
import scalus.ledger.api.v1.Value
// Value extension ops (`getLovelace`, `policyIds`, …) mirror Aiken's
// `lovelace_of` / `policies` helpers used by the reference auction validator.
import scalus.ledger.api.v1.Value.*
import scalus.ledger.api.v2.TxOut
import scalus.ledger.api.v2.OutputDatum.{NoOutputDatum, OutputDatum}
// `PolicyId` is the v3 alias used by `Validator.mint`; the v1 one has the
// same underlying ByteString shape but a different path, and Scalus 0.14
// rejects overrides that don't match the exact declared path.
import scalus.ledger.api.v3.{PolicyId, PubKeyHash, TxInfo, TxOutRef}
import scalus.prelude.{*, given}

case class AuctionDatum(
  seller: PubKeyHash,
  highest_bidder: PubKeyHash,
  highest_bid: BigInt,
  expiration: BigInt,
  asset_policy: ByteString,
  asset_name: ByteString
) derives FromData, ToData

enum Action derives FromData, ToData:
  case BID
  case WITHDRAW
  case END

// Multi-purpose validator. The Aiken counterpart (auction.auction.{mint,spend})
// produces a single script that dispatches on ScriptContext purpose, and the
// off-chain code grabs `validators[0]` from plutus.json and uses the same
// compiled bytes for both the minting policy AND the spending validator.
// Extending `Validator` here gives us the same dispatcher (`validate`) so the
// emitted script handles MintingScript and SpendingScript contexts; otherwise
// the spend-only script crashes with `InvalidReturnValue` when invoked in a
// minting context.
@Compile
object AuctionValidator extends Validator:
  // `Validator.spend` and `Validator.mint` are declared `inline` in Scalus
  // 0.14, so overrides have to carry the `inline` modifier too — otherwise
  // the compiler refuses with "is not inline, cannot implement an inline
  // method" (E164).
  inline override def spend(
    datum: Option[Data],
    redeemer: Data,
    tx: TxInfo,
    sourceTxOutRef: TxOutRef
  ): Unit =
    val scalus.prelude.Option.Some(datumData) = datum: @unchecked
    val auctionDatum = datumData.to[AuctionDatum]
    val AuctionDatum(seller, highest_bidder, highest_bid, expiration, asset_policy, asset_name) = auctionDatum

    // Resolve the spent input — we need both its address (the script address)
    // and its value (to assert the auctioned asset is actually locked).
    val ownInput = tx.inputs.find(i => i.outRef === sourceTxOutRef) match
      case scalus.prelude.Option.Some(x) => x
      case _ =>
        require(false, "Spent input not found")
        tx.inputs.head // unreachable; satisfies the type
    val scriptAddress = ownInput.resolved.address
    val inputValue = ownInput.resolved.value

    // "No bids yet" sentinel — mirrors Aiken's empty-bytes (`""`) highest_bidder.
    val noBids = highest_bidder === PubKeyHash(ByteString.empty)

    // Mirrors Aiken's `list.has(policies(value), asset_policy)`: the auctioned
    // asset is identified by its policy id (the script's own mint policy).
    def carriesAsset(v: Value): Boolean =
      v.policyIds.find(p => p === asset_policy).isDefined

    val action = redeemer.to[Action]

    action match
      case Action.BID =>
        // Exactly one continuing output back at the script address.
        val continuing = tx.outputs.filter(o => o.address === scriptAddress)
        require(continuing.length === BigInt(1), "Exactly one continuing output required")
        val cont = continuing.head
        val OutputDatum(newDatumData) = cont.datum: @unchecked
        val newDatum = newDatumData.to[AuctionDatum]

        val newHighest = newDatum.highest_bidder
        val newBid = newDatum.highest_bid

        // Previous bidder is refunded their exact stake in the same tx; the
        // first bid (sentinel bidder) has nothing to refund.
        val refundOk =
          if noBids then true
          else
            tx.outputs
              .find(o =>
                o.address.credential === Credential.PubKeyCredential(highest_bidder)
                  && o.value.getLovelace === highest_bid
              )
              .isDefined

        require(tx.validRange.isEntirelyBefore(expiration), "Auction not expired for BID")
        require(newBid > highest_bid, "Bid must increase")
        require(tx.signatories.find(p => p === newHighest).isDefined, "Highest bidder must sign")
        require(newDatum.seller === seller, "Seller must not change")
        require(newDatum.asset_policy == asset_policy, "Asset policy must not change")
        require(newDatum.asset_name == asset_name, "Asset name must not change")
        require(newDatum.expiration == expiration, "Expiration must not change")
        require(carriesAsset(inputValue), "Auctioned asset must be present on input")
        require(carriesAsset(cont.value), "Auctioned asset must stay locked")
        require(refundOk, "Previous bidder must be refunded their bid")
        // Non-decreasing — a bidder may pile on extra ada for the next refund,
        // but can't drain the pot.
        require(cont.value.getLovelace >= inputValue.getLovelace, "Locked lovelace must not decrease")

      case Action.END =>
        // Settles after expiration. Permissionless: anyone may close it as long
        // as the winner gets the item and the seller is paid (matches Aiken —
        // no seller signature required on the bidded branch).
        require(tx.validRange.isEntirelyAfter(expiration), "Auction must be expired")

        // No continuing script output — the auction's lifetime ends here.
        val continues = tx.outputs.find(o => o.address === scriptAddress).isDefined
        require(!continues, "No continuing auction output allowed on END")

        // Exactly one output carries the auctioned asset — tolerates fee-change
        // and other outputs (unlike a rigid total-output-count check).
        val outputsWithAsset = tx.outputs.filter(o => carriesAsset(o.value))
        require(outputsWithAsset.length === BigInt(1), "Exactly one asset-bearing output required")
        val itemOut = outputsWithAsset.head

        if noBids then
          // No bids — the asset returns to the seller, who must authorise it.
          require(
            itemOut.address.credential === Credential.PubKeyCredential(seller),
            "Item must return to seller when no bids"
          )
          require(tx.signatories.find(p => p === seller).isDefined, "Seller must sign END with no bids")
        else
          // Asset to the winner; seller paid at least the winning bid.
          require(
            itemOut.address.credential === Credential.PubKeyCredential(highest_bidder),
            "Item must go to highest bidder"
          )
          require(
            tx.outputs
              .find(o =>
                o.address.credential === Credential.PubKeyCredential(seller)
                  && o.value.getLovelace >= highest_bid
              )
              .isDefined,
            "Seller must receive at least the highest bid"
          )

      case Action.WITHDRAW =>
        // Refunds happen inline in BID; a standalone withdraw path would need
        // per-bidder accounting. Forbid it, matching Aiken's `WITHDRAW -> fail`.
        require(false, "WITHDRAW not implemented")

  inline override def mint(
    redeemer: Data,
    policyId: PolicyId,
    tx: TxInfo
  ): Unit =
    val scalus.prelude.Option.Some(auctionOutput: TxOut) =
      tx.outputs.find(o => o.address.credential === Credential.ScriptCredential(policyId)): @unchecked

    val OutputDatum(datumData) = auctionOutput.datum: @unchecked
    val auctionDatum = datumData.to[AuctionDatum]
    val AuctionDatum(seller, highest_bidder, highest_bid, expiration, asset_policy, asset_name) = auctionDatum

    require(tx.signatories.find(p => p === seller).isDefined, "Seller must sign mint")
    require(highest_bid >= 0, "Starting bid must be non-negative")
    require(tx.validRange.isEntirelyBefore(expiration), "Auction must start before expiration")
    // The auctioned asset must actually be locked at the script output, keyed
    // by its policy id (matches Aiken's `has_auction_asset`).
    require(
      auctionOutput.value.policyIds.find(p => p === asset_policy).isDefined,
      "Auctioned asset must be locked at mint"
    )
