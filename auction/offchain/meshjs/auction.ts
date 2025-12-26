import {
  BuiltinByteString,
  ConStr0,
  ConStr1,
  Integer,
  mConStr0,
  mConStr1,
  DEFAULT_REDEEMER_BUDGET,
  MeshValue,
  PubKeyAddress,
  pubKeyAddress,
  Value,
  value,
} from '@meshsdk/common';
import {
  Asset,
  deserializeAddress,
  deserializeDatum,
  mergeAssets,
  serializeAddressObj,
  UTxO,
} from '@meshsdk/core';
import { applyParamsToScript } from '@meshsdk/core-cst';

import { MeshTxInitiator, MeshTxInitiatorInput } from '../common';
import blueprintV1 from './aiken-workspace-v1/plutus.json';
import blueprintV2 from './aiken-workspace-v2/plutus.json';

// AuctionDatum mirrors on-chain: seller, highest_bidder, highest_bid, expiration, asset_policy, asset_name
// Encoding as a constructor with 6 fields for convenient JSON representation.
export type AuctionDatum = ConStr0<
  [
    PubKeyAddress,
    PubKeyAddress,
    Integer,
    Integer,
    BuiltinByteString,
    BuiltinByteString
  ]
>;

// Redeemers for actions (align with on-chain schema as needed)
export type BidRedeemer = ConStr0<[]>; // BID
export type EndRedeemer = ConStr1<[]>; // END

export const bidRedeemer = (): BidRedeemer => mConStr0([]);
export const endRedeemer = (): EndRedeemer => mConStr1([]);

export const makeAuctionDatum = (
  sellerAddress: string,
  expirationMs: number,
  assetPolicyIdHex: string,
  assetNameHex: string,
  startingBid: number | bigint = 0n
): AuctionDatum => {
  const { pubKeyHash, stakeCredentialHash } = deserializeAddress(sellerAddress);
  return mConStr0([
    pubKeyAddress(pubKeyHash, stakeCredentialHash),
    pubKeyAddress(pubKeyHash, stakeCredentialHash), // initial highest_bidder = seller
    BigInt(startingBid),
    BigInt(expirationMs),
    assetPolicyIdHex,
    assetNameHex,
  ]);
};

function splitUnit(unit: string): { policyId: string; assetName: string } {
  // unit format: "lovelace" or "<policyId>.<assetName>"
  if (unit === 'lovelace') return { policyId: '', assetName: '' };
  const dot = unit.indexOf('.');
  if (dot < 0) return { policyId: unit, assetName: '' };
  return { policyId: unit.slice(0, dot), assetName: unit.slice(dot + 1) };
}

function findFirstNonLovelace(assets: Asset[]): Asset | undefined {
  return assets.find((a) => a.unit !== 'lovelace');
}

export class MeshAuctionContract extends MeshTxInitiator {
  scriptCbor: string;
  scriptAddress: string;

  constructor(inputs: MeshTxInitiatorInput) {
    super(inputs);
    this.scriptCbor = this.getScriptCbor();
    this.scriptAddress = this.getScriptAddress(this.scriptCbor);
  }

  getScriptCbor = () => {
    switch (this.version) {
      case 2:
        return applyParamsToScript(blueprintV2.validators[0]!.compiledCode, []);
      default:
        return applyParamsToScript(blueprintV1.validators[0]!.compiledCode, []);
    }
  };

  // Start an auction by locking the auctioned asset at the script with an inline datum
  startAuction = async (
    auctionAmount: Asset[],
    expirationMs: number,
    startingBid: number | bigint = 0n
  ): Promise<string> => {
    const { utxos, walletAddress } = await this.getWalletInfoForTx();

    const nft = findFirstNonLovelace(auctionAmount);
    if (!nft)
      throw new Error(
        'auctionAmount must include a non-lovelace asset (e.g. NFT)'
      );
    const { policyId, assetName } = splitUnit(nft.unit);

    const datum = makeAuctionDatum(
      walletAddress,
      expirationMs,
      policyId,
      assetName,
      startingBid
    );

    await this.mesh
      .txOut(this.scriptAddress, auctionAmount)
      .txOutInlineDatumValue(datum, 'JSON')
      .changeAddress(walletAddress)
      .selectUtxosFrom(utxos)
      .complete();
    return this.mesh.txHex;
  };

  // Place a bid by consuming the auction UTxO and creating one continuing output
  // with updated datum (highest_bidder and highest_bid).
  placeBid = async (
    auctionUtxo: UTxO,
    bidLovelace: bigint
  ): Promise<string> => {
    const { utxos, walletAddress, collateral } =
      await this.getWalletInfoForTx();

    // Decode current datum
    const inputDatum = deserializeDatum<AuctionDatum>(
      auctionUtxo.output.plutusData!
    );
    const [
      sellerAddrObj,
      _prevBidder,
      prevBid,
      expiration,
      policyId,
      assetName,
    ] = inputDatum.fields;

    // Build updated datum
    const { pubKeyHash, stakeCredentialHash } =
      deserializeAddress(walletAddress);
    const updatedDatum = mConStr0([
      sellerAddrObj,
      pubKeyAddress(pubKeyHash, stakeCredentialHash), // new highest bidder
      BigInt(bidLovelace),
      expiration,
      policyId,
      assetName,
    ]);

    // Increase lovelace at the script by the delta (bid - prevBid)
    const currentScriptAssets = MeshValue.fromValue(
      auctionUtxo.output.amount
    ).toAssets();
    const delta = BigInt(bidLovelace) - BigInt(prevBid);
    if (delta < 0n) throw new Error('New bid must be >= previous bid');
    const nextAssets =
      delta > 0n
        ? mergeAssets([
            ...currentScriptAssets,
            { unit: 'lovelace', quantity: delta.toString() },
          ])
        : currentScriptAssets;

    await this.mesh
      .spendingPlutusScript(this.languageVersion)
      .txIn(
        auctionUtxo.input.txHash,
        auctionUtxo.input.outputIndex,
        auctionUtxo.output.amount,
        this.scriptAddress
      )
      .spendingReferenceTxInInlineDatumPresent()
      .txInRedeemerValue(bidRedeemer(), 'JSON', DEFAULT_REDEEMER_BUDGET)
      .txInScript(this.scriptCbor)
      .txOut(this.scriptAddress, nextAssets)
      .txOutInlineDatumValue(updatedDatum, 'JSON')
      .changeAddress(walletAddress)
      .txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address
      )
      .selectUtxosFrom(utxos)
      .complete();

    return this.mesh.txHex;
  };

  // End the auction by paying the NFT to the highest bidder and
  // the highest bid (lovelace) to the seller. Consumes the UTxO and
  // produces exactly two outputs.
  endAuction = async (auctionUtxo: UTxO): Promise<string> => {
    const { utxos, walletAddress, collateral } =
      await this.getWalletInfoForTx();

    const datum = deserializeDatum<AuctionDatum>(
      auctionUtxo.output.plutusData!
    );
    const [
      sellerAddrObj,
      highestBidderAddrObj,
      highestBid,
      _expiration,
      policyId,
      assetName,
    ] = datum.fields;

    const sellerAddress = serializeAddressObj(sellerAddrObj, this.networkId);
    const highestBidderAddress = serializeAddressObj(
      highestBidderAddrObj,
      this.networkId
    );

    // Extract auctioned asset from the script UTxO amount (by policyId+assetName)
    const scriptAssets = MeshValue.fromValue(
      auctionUtxo.output.amount
    ).toAssets();
    const unit = policyId && assetName ? `${policyId}.${assetName}` : '';
    const auctionedAssets = unit
      ? scriptAssets.filter((a) => a.unit === unit)
      : [];

    if (auctionedAssets.length === 0)
      throw new Error('Auctioned asset not found at script UTxO');

    // Payment to seller in lovelace equals highestBid
    const sellerPayment: Asset[] =
      BigInt(highestBid) > 0n
        ? [{ unit: 'lovelace', quantity: BigInt(highestBid).toString() }]
        : [];

    await this.mesh
      .spendingPlutusScript(this.languageVersion)
      .txIn(
        auctionUtxo.input.txHash,
        auctionUtxo.input.outputIndex,
        auctionUtxo.output.amount,
        this.scriptAddress
      )
      .spendingReferenceTxInInlineDatumPresent()
      .spendingReferenceTxInRedeemerValue(mConStr1([]))
      .txInScript(this.scriptCbor)
      .txOut(highestBidderAddress, auctionedAssets)
      .txOut(sellerAddress, sellerPayment)
      .requiredSignerHash(deserializeAddress(sellerAddress).pubKeyHash)
      .changeAddress(walletAddress)
      .txInCollateral(
        collateral.input.txHash,
        collateral.input.outputIndex,
        collateral.output.amount,
        collateral.output.address
      )
      .selectUtxosFrom(utxos)
      .complete();

    return this.mesh.txHex;
  };

  getUtxoByTxHash = async (txHash: string): Promise<UTxO | undefined> => {
    return await this._getUtxoByTxHash(txHash, this.scriptCbor);
  };
}
