import type { ConStr0, BuiltinByteString, Integer } from '@meshsdk/common';
import {
  builtinByteString,
  conStr0,
  DEFAULT_REDEEMER_BUDGET,
  integer,
  mConStr0,
  mConStr2,
  pubKeyAddress,
} from '@meshsdk/common';
import type { Asset, UTxO } from '@meshsdk/core';
import {
  deserializeAddress,
  deserializeDatum,
  mergeAssets,
  serializeAddressObj,
} from '@meshsdk/core';
import { applyParamsToScript } from '@meshsdk/core-cst';

import { MeshTxInitiator } from '../src/common.js';
import type { MeshTxInitiatorInput } from '../src/common.js';
import blueprint from '../../../onchain/aiken/plutus.json' with { type: 'json' };

export type AuctionDatum = ConStr0<
  [
    BuiltinByteString, // seller
    BuiltinByteString, // highest_bidder
    Integer, // highest_bid
    Integer, // expiration
    BuiltinByteString, // asset_policy
    BuiltinByteString // asset_name
  ]
>;

export const auctionDatum = (
  seller: string,
  highestBidder: string,
  highestBid: number | bigint,
  expiration: number | bigint,
  assetPolicy: string,
  assetName: string
): AuctionDatum => {
  return conStr0([
    builtinByteString(seller),
    builtinByteString(highestBidder),
    integer(Number(highestBid)),
    integer(Number(expiration)),
    builtinByteString(assetPolicy),
    builtinByteString(assetName),
  ]);
};

export class MeshAuctionContract extends MeshTxInitiator {
  scriptCbor: string;
  scriptAddress: string;

  constructor(inputs: MeshTxInitiatorInput) {
    super(inputs);
    this.scriptCbor = this.getScriptCbor();
    this.scriptAddress = this.getScriptAddress(this.scriptCbor);
  }

  getScriptCbor = () => {
    return applyParamsToScript(blueprint.validators[0]!.compiledCode, []);
  };

  initiateAuction = async (
    auctionedAsset: Asset,
    expiration: number,
    startingBid: number
  ): Promise<string> => {
    const { utxos, walletAddress } = await this.getWalletInfoForTx();
    const { pubKeyHash } = deserializeAddress(walletAddress);

    const assetPolicy = auctionedAsset.unit.slice(0, 56);
    const assetName = auctionedAsset.unit.slice(56);

    const datum = auctionDatum(
      pubKeyHash,
      '',
      startingBid,
      expiration,
      assetPolicy,
      assetName
    );

    const assets = mergeAssets([
      auctionedAsset,
      { unit: 'lovelace', quantity: startingBid.toString() },
    ]);

    await this.mesh
      .txOut(this.scriptAddress, assets)
      .txOutInlineDatumValue(datum, 'JSON')
      .changeAddress(walletAddress)
      .selectUtxosFrom(utxos)
      .complete();
    return this.mesh.txHex;
  };

  placeBid = async (auctionUtxo: UTxO, bidAmount: number): Promise<string> => {
    const { utxos, walletAddress, collateral } =
      await this.getWalletInfoForTx();
    const { pubKeyHash } = deserializeAddress(walletAddress);

    const inputDatum = deserializeDatum<AuctionDatum>(
      auctionUtxo.output.plutusData!
    );
    const [seller, _prevBidder, _prevBid, expiration, assetPolicy, assetName] =
      inputDatum.fields;

    const outputDatum = auctionDatum(
      seller as unknown as string,
      pubKeyHash,
      bidAmount,
      Number(expiration),
      assetPolicy as unknown as string,
      assetName as unknown as string
    );

    const asset: Asset = {
      unit: (assetPolicy as unknown as string) + (assetName as unknown as string),
      quantity: '1',
    };
    const assets = mergeAssets([
      asset,
      { unit: 'lovelace', quantity: bidAmount.toString() },
    ]);

    await this.mesh
      .spendingPlutusScript(this.languageVersion)
      .txIn(
        auctionUtxo.input.txHash,
        auctionUtxo.input.outputIndex,
        auctionUtxo.output.amount,
        this.scriptAddress
      )
      .spendingReferenceTxInInlineDatumPresent()
      .txInRedeemerValue(mConStr0([]), 'JSON', DEFAULT_REDEEMER_BUDGET)
      .txInScript(this.scriptCbor)
      .txOut(this.scriptAddress, assets)
      .txOutInlineDatumValue(outputDatum, 'JSON')
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

  endAuction = async (auctionUtxo: UTxO): Promise<string> => {
    const { utxos, walletAddress, collateral } =
      await this.getWalletInfoForTx();

    const inputDatum = deserializeDatum<AuctionDatum>(
      auctionUtxo.output.plutusData!
    );
    const [
      seller,
      highestBidder,
      highestBid,
      expiration,
      assetPolicy,
      assetName,
    ] = inputDatum.fields;

    const sellerAddress = serializeAddressObj(
      pubKeyAddress(seller as unknown as string),
      this.networkId
    );
    const winnerAddress = serializeAddressObj(
      pubKeyAddress(highestBidder as unknown as string),
      this.networkId
    );

    const auctionedAsset: Asset = {
      unit: (assetPolicy as unknown as string) + (assetName as unknown as string),
      quantity: '1',
    };

    await this.mesh
      .spendingPlutusScript(this.languageVersion)
      .txIn(
        auctionUtxo.input.txHash,
        auctionUtxo.input.outputIndex,
        auctionUtxo.output.amount,
        this.scriptAddress
      )
      .spendingReferenceTxInInlineDatumPresent()
      .txInRedeemerValue(mConStr2([]), 'JSON', DEFAULT_REDEEMER_BUDGET)
      .txInScript(this.scriptCbor)
      .txOut(winnerAddress, [auctionedAsset])
      .txOut(sellerAddress, [
        { unit: 'lovelace', quantity: highestBid.toString() },
      ])
      .invalidBefore(Number(expiration))
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
