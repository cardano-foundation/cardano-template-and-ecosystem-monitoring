import { Lucid, Koios } from '@evolution-sdk/lucid';

async function fundWallet1() {
  const lucid = await Lucid(
    new Koios('https://preprod.koios.rest/api/v1'),
    'Preprod'
  );

  const mnemonic0 = await Deno.readTextFile('wallet_0.txt');
  lucid.selectWallet.fromSeed(mnemonic0);
  const addr0 = await lucid.wallet().address();

  const mnemonic1 = await Deno.readTextFile('wallet_1.txt');
  lucid.selectWallet.fromSeed(mnemonic1);
  const addr1 = await lucid.wallet().address();

  // Select wallet 0 again to send funds
  lucid.selectWallet.fromSeed(mnemonic0);

  console.log(
    `Sending 10 ADA from Wallet 0 (${addr0}) to Wallet 1 (${addr1})...`
  );

  const tx = await lucid
    .newTx()
    .pay.ToAddress(addr1, { lovelace: 10_000_000n })
    .complete();

  const signedTx = await tx.sign.withWallet();
  const txHash = await (await signedTx.complete()).submit();

  console.log(`Transaction submitted: ${txHash}`);
}

fundWallet1();
