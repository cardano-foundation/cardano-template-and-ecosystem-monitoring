import { MeshWallet, KoiosProvider } from '@meshsdk/core';

const mnemonic = JSON.parse(Deno.readTextFileSync('wallet_0.txt'));
const wallet = new MeshWallet({
  networkId: 0,
  fetcher: new KoiosProvider('preprod'),
  key: {
    type: 'mnemonic',
    words: mnemonic,
  },
});

console.log(await wallet.getChangeAddress());
