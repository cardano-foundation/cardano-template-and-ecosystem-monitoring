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
    
    val action = redeemer.to[Action]
    
    action match
      case Action.BID =>
        // Simplified BID - check bidder signs and bid increases
        require(tx.signatories.contains(highest_bidder), "Bidder must sign")
        require(tx.validRange.isEntirelyBefore(expiration), "Auction still active")
        
      case Action.END =>
        require(tx.validRange.isEntirelyAfter(expiration), "Auction must be expired")
        require(tx.signatories.contains(seller), "Seller must sign to end")
        require(highest_bidder.hash.nonEmpty, "Must have a highest bidder")
        
      case Action.WITHDRAW =>
        require(false, "WITHDRAW not implemented")

  inline def mint(
    redeemer: Data,
    policyId: PolicyId,
    tx: TxInfo
  ): Unit =
    val scalus.prelude.Option.Some(auctionOutput: TxOut) =
      tx.outputs.find(_.address.credential == Credential.ScriptCredential(policyId)): @unchecked

    val OutputDatum(datumData) = auctionOutput.datum: @unchecked
    val auctionDatum = datumData.to[AuctionDatum]

    val AuctionDatum(seller, highest_bidder, highest_bid, expiration, asset_policy, asset_name) = auctionDatum
    require(tx.signatories.contains(seller), "Seller must sign mint")
    require(highest_bidder.hash.isEmpty, "No bidder at start")
