import { Lucid, Koios } from '@evolution-sdk/lucid';

async function showAddresses() {
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
      const address = await lucid.wallet().address();
      console.log(`Wallet ${index} address: ${address}`);
    } catch (e: any) {
      console.log(`Error reading ${file}: ${e.message}`);
    }
  }
}

showAddresses();
