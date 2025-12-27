import {
  BrowserWallet,
  MeshTxBuilder,
  serializePlutusScript,
} from '@meshsdk/core';
import type { UTxO } from '@meshsdk/core';

export interface MeshTxInitiatorInput {
  mesh: MeshTxBuilder;
  fetcher: {
    fetchAddressUtxos(address: string): Promise<UTxO[]>;
  };
  wallet: BrowserWallet;
  networkId: 0 | 1;
}

export class MeshTxInitiator {
  mesh: MeshTxBuilder;
  fetcher: {
    fetchAddressUtxos(address: string): Promise<UTxO[]>;
  };
  wallet: BrowserWallet;
  networkId: 0 | 1;
  languageVersion: 'V1' | 'V2' = 'V2';

  constructor(inputs: MeshTxInitiatorInput) {
    this.mesh = inputs.mesh;
    this.fetcher = inputs.fetcher;
    this.wallet = inputs.wallet;
    this.networkId = inputs.networkId;
  }

  getWalletInfoForTx = async () => {
    const utxos = await this.wallet.getUtxos();
    const walletAddress = await this.wallet
      .getUsedAddresses()
      .then((a) => a[0]!);
    const collateral = (await this.wallet.getCollateral())[0]!;
    return { utxos, walletAddress, collateral };
  };

  getScriptAddress = (scriptCbor: string) => {
    return serializePlutusScript({ code: scriptCbor, version: 'V2' }).address;
  };

  _getUtxoByTxHash = async (
    txHash: string,
    scriptCbor: string
  ): Promise<UTxO | undefined> => {
    const scriptAddress = this.getScriptAddress(scriptCbor);
    const utxos = await this.fetcher.fetchAddressUtxos(scriptAddress);
    return utxos.find((utxo) => utxo.input.txHash === txHash);
  };
}
