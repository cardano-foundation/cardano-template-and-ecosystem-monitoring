package scalus.examples.auction

import scalus.Compile
import scalus.builtin.*
import scalus.builtin.Data
import scalus.builtin.Data.FromData
import scalus.builtin.Data.ToData
import scalus.builtin.ToData.*
import scalus.ledger.api.v1.{Credential, PolicyId}
import scalus.ledger.api.v2.TxOut
import scalus.ledger.api.v2.OutputDatum.{NoOutputDatum, OutputDatum}
import scalus.ledger.api.v3.{PubKeyHash, TxInfo, TxOutRef}
import scalus.prelude.*

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

@Compile
object AuctionValidator:
  inline def spend(
    datum: Option[Data],
    redeemer: Data,
    tx: TxInfo,
    sourceTxOutRef: TxOutRef
  ): Unit =
    val scalus.prelude.Option.Some(datumData) = datum: @unchecked
    val auctionDatum = datumData.to[AuctionDatum]
    val AuctionDatum(seller, highest_bidder, highest_bid, expiration, asset_policy, asset_name) = auctionDatum

    // Resolve the spent input and script address
    val scriptAddress = tx.inputs.find(i => i.outRef === sourceTxOutRef) match
      case scalus.prelude.Option.Some(x) => x.resolved.address
      case _ =>
        require(false, "Spent input not found")
        // Unreachable default to satisfy types
        tx.outputs.head.address

    val action = redeemer.to[Action]

    action match
      case Action.BID =>
        // Continuing output at the same script address
        val continuing = tx.outputs.filter(o => o.address === scriptAddress)
        require(continuing.length === BigInt(1), "Exactly one continuing output required")
        val cont = continuing.head
        val OutputDatum(newDatumData) = cont.datum: @unchecked
        val newDatum = newDatumData.to[AuctionDatum]

        // New bidder and new bid
        val newHighest = newDatum.highest_bidder
        val newBid = newDatum.highest_bid

        // Checks per Aiken spec (without asset/lovelace helpers yet)
        require(tx.validRange.isEntirelyBefore(expiration), "Auction not expired for BID")
        require(newBid > highest_bid, "Bid must increase")
        require(tx.signatories.find(p => p === newHighest).isDefined, "Highest bidder must sign")
        require(newDatum.seller === seller, "Seller must not change")
        require(newDatum.asset_policy == asset_policy, "Asset policy must not change")
        require(newDatum.asset_name == asset_name, "Asset name must not change")
        require(newDatum.expiration == expiration, "Expiration must not change")

      case Action.END =>
        // Auction must be expired and seller must sign
        require(tx.validRange.isEntirelyAfter(expiration), "Auction must be expired")
        require(tx.signatories.find(p => p === seller).isDefined, "Seller must sign END")

        // No continuing script outputs
        val continues = tx.outputs.find(o => o.address === scriptAddress).isDefined
        require(!continues, "No continuing auction output allowed on END")

        // Exactly two outputs: one to winner, one to seller
        require(tx.outputs.length === BigInt(2), "Exactly two outputs required on END")
        val itemOutOpt = tx.outputs.find(o => o.address.credential === Credential.PubKeyCredential(highest_bidder))
        val sellerOutOpt = tx.outputs.find(o => o.address.credential === Credential.PubKeyCredential(seller))
        require(itemOutOpt.isDefined, "Item must go to highest bidder")
        require(sellerOutOpt.isDefined, "Seller must receive payment")

        val sellerOut = sellerOutOpt.get
        require(sellerOut.datum === NoOutputDatum, "Seller output must have no datum")

        // Ensure someone actually bid (use bid amount > 0)
        require(highest_bid > 0, "No bids to settle")

      case Action.WITHDRAW =>
        // Not implemented: forbid for safety until full refund logic exists
        require(false, "WITHDRAW not implemented")

  inline def mint(
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
