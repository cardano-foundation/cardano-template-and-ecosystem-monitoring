import { MeshWallet, KoiosProvider } from '@meshsdk/core';

async function check(i: number) {
  const mnemonic = JSON.parse(Deno.readTextFileSync(`wallet_${i}.txt`));
  const wallet = new MeshWallet({
    networkId: 0,
    fetcher: new KoiosProvider('preprod'),
    key: {
      type: 'mnemonic',
      words: mnemonic,
    },
  });
  const addr = await wallet.getChangeAddress();
  const utxos = await wallet.getUtxos();
  console.log(`Wallet ${i}: ${addr}`);
  console.log(`UTXOs: ${utxos.length}`);
}

for (let i = 0; i < 5; i++) {
  try {
    await check(i);
  } catch (e) {}
}
