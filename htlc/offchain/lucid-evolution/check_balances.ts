import { Lucid, Koios } from '@evolution-sdk/lucid';

async function checkBalances() {
  const lucid = await Lucid(
    new Koios('https://preprod.koios.rest/api/v1'),
    'Preprod'
  );

  const files = Deno.readDirSync('.');
  const walletFiles = [];
  for (const file of files) {
    if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
      walletFiles.push(file.name);
    }
  }
  walletFiles.sort();

  for (const file of walletFiles) {
    try {
      const index = file.match(/[0-9]+/)![0];
      const mnemonic = await Deno.readTextFile(file);
      lucid.selectWallet.fromSeed(mnemonic);
      const addr = await lucid.wallet().address();
      const utxos = await lucid.utxosAt(addr);
      const balance = utxos.reduce(
        (acc, utxo) => acc + utxo.assets.lovelace,
        0n
      );
      console.log(`Wallet ${index} address: ${addr}`);
      console.log(
        `Balance: ${balance} lovelace (${Number(balance) / 1_000_000} ADA)`
      );
    } catch (e: any) {
      console.log(`Error reading ${file}: ${e.message}`);
    }
  }
}

checkBalances();
