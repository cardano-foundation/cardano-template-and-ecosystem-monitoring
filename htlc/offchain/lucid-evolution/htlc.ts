import { Lucid, Koios, Data, generateSeedPhrase, validatorToAddress, Validator, fromText, getAddressDetails, LucidEvolution, TUnsafe } from "@evolution-sdk/lucid";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

const HtlcDatumSchema = Data.Object({
  owner: Data.Bytes(),
  recipient: Data.Bytes(),
  hash: Data.Bytes(),
  expiration: Data.Integer(),
});
type HtlcDatum = Data.Static<typeof HtlcDatumSchema>;
const HtlcDatum = HtlcDatumSchema as unknown as HtlcDatum;

async function prepare (amount: number) {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );

  const addresses = [];
  for (let i = 0; i < amount; i++) {
    const mnemonic = generateSeedPhrase();
    lucid.selectWallet.fromSeed(mnemonic);
    const address = await lucid.wallet().address();
    addresses.push(address);
    Deno.writeTextFileSync(`wallet_${i}.txt`, mnemonic);
  }
  console.log(`Successfully prepared ${amount} wallet (seed phrases).`);
  console.log(`Make sure to send some tADA to the wallet ${addresses[0]} for fees and collateral.`);
}

function selectWallet (lucid: LucidEvolution, index: number) {
  const mnemonic = Deno.readTextFileSync(`wallet_${index}.txt`);
  lucid.selectWallet.fromSeed(mnemonic);
}

async function setup () {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );
  selectWallet(lucid, 0);

  const validator: Validator = {
    type: "PlutusV3",
    script: blueprint.validators[0].compiledCode,
  };

  const scriptAddress = validatorToAddress("Preprod", validator);

  return {
    lucid,
    scriptAddress,
    validator,
  }
}

async function sha256 (input: string) {
  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(hash).map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex;
}

async function initHtlc(lovelaceAmount: string, secret: string, recipientIndex = 1) {
  const { lucid, scriptAddress, validator } = await setup();

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);

  selectWallet(lucid, recipientIndex);
  const recipientAddress = await lucid.wallet().address();
  const { paymentCredential: recipientPaymentCredential } = getAddressDetails(recipientAddress);

  const secretHash = await sha256(secret);
  const datum = Data.to({
    owner: paymentCredential?.hash || '',
    recipient: recipientPaymentCredential?.hash || '',
    hash: secretHash,
    expiration: BigInt(Date.now() + 60 * 60 * 24 * 2 * 1000),
  }, HtlcDatum);

  selectWallet(lucid, 0);
  const tx = await lucid.newTx()
      .pay.ToContract(
        scriptAddress,
        { kind: "inline", value: datum },
        { lovelace: BigInt(lovelaceAmount) },
      )
      .addSigner(address)
      ;

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(`Successfully locked ${lovelaceAmount} lovelace to ${scriptAddress}.
See: https://preprod.cexplorer.io/tx/${txHash}`);
    console.log(`Use the following command to claim:
deno run -A htlc.ts claim ${txHash} <preimage>`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}

async function claimHtlc(transactionId: string, preimage: string) {
  console.log(`Claiming HTLC with transaction ID: "${transactionId}"`);
  const { lucid, scriptAddress, validator } = await setup();

  selectWallet(lucid, 1);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  console.log(`Using wallet address: ${address}`);

  let utxos = [];

  try {
    utxos = await lucid.utxosByOutRef([{ txHash: transactionId, outputIndex: 0 }]);
    if (utxos.length === 0) {
      // try other output indexes if the default 0 didn't return anything
      for (let i = 1; i < 10 && utxos.length === 0; i++) {
        try {
          utxos = await lucid.utxosByOutRef([{ txHash: transactionId, outputIndex: i }]);
        } catch (_) {
          // ignore and continue
        }
      }
    }
  } catch (error) {
    console.error(`Error fetching UTXOs for transaction ID ${transactionId}:`, error);
    return;
  }

  if (utxos.length === 0) {
    try {
      const all = await (lucid as any).utxosAt(scriptAddress);
      if (Array.isArray(all) && all.length > 0) {
        utxos = all.filter((u: any) => (u.txHash || u.outRef?.txHash) === transactionId);
      }
    } catch (_) {
      // ignore if method not available
    }
    console.error(`No UTXOs found for transaction ID: ${transactionId}`);
    return;
  }

  const utxo = utxos[0];
  if (!utxo.datum) {
    console.error(`UTXO with transaction ID ${transactionId} does not have a datum.`);
    return;
  }

  const datum = Data.from(utxo.datum, HtlcDatum);
  const preimageHash = await sha256(preimage);
  console.log('Script datum:', datum);

  // Build redeemer. The on-chain contract expects a constructor 'GUESS' with the answer bytes.
  // We construct the redeemer as raw bytes of the preimage for the GUESS branch.
    const preimageBytes = new TextEncoder().encode(preimage);
    const preimageHex = Array.from(preimageBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const redeemer = Data.to(preimageHex as unknown as TUnsafe<string>, Data.Bytes());

  const assetEntry = Object.values(utxo.assets)[0];
  const lovelaceAmount = typeof assetEntry === "bigint" ? assetEntry : BigInt((assetEntry as any).coin || 0);

  const tx = await lucid.newTx()
      .attach.SpendingValidator(validator)
      .collectFrom([utxo], redeemer)
      .pay.ToAddress(
        await lucid.wallet().address(),
        { lovelace: lovelaceAmount }
      )
      .addSigner(address)
      ;

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(`Successfully claimed HTLC with transaction ID ${transactionId}.
See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}

async function refundHtlc(transactionId: string) {
  console.log(`Refunding HTLC with transaction ID: "${transactionId}"`);
  const { lucid, scriptAddress, validator } = await setup();

  selectWallet(lucid, 0);

  const address = await lucid.wallet().address();
  console.log(`Using wallet address: ${address}`);

  let utxos = [];

  try {
    utxos = await lucid.utxosByOutRef([{ txHash: transactionId, outputIndex: 0 }]);
    if (utxos.length === 0) {
      for (let i = 1; i < 10 && utxos.length === 0; i++) {
        try {
          utxos = await lucid.utxosByOutRef([{ txHash: transactionId, outputIndex: i }]);
        } catch (_) {}
      }
    }
  } catch (error) {
    console.error(`Error fetching UTXOs for transaction ID ${transactionId}:`, error);
    return;
  }

  if (utxos.length === 0) {
    try {
      const all = await (lucid as any).utxosAt(scriptAddress);
      if (Array.isArray(all) && all.length > 0) {
        utxos = all.filter((u: any) => (u.txHash || u.outRef?.txHash) === transactionId);
      }
    } catch (_) {}
    console.error(`No UTXOs found for transaction ID: ${transactionId}`);
    return;
  }

  const utxo = utxos[0];
  if (!utxo.datum) {
    console.error(`UTXO with transaction ID ${transactionId} does not have a datum.`);
    return;
  }

  // For refund we use an empty redeemer (WITHDRAW constructor expected on-chain).
    const redeemer = Data.void();
  
    const assetEntry = Object.values(utxo.assets)[0];
    const lovelaceAmount = typeof assetEntry === "bigint" ? assetEntry : BigInt((assetEntry as any)?.coin || 0);
  
    const tx = await lucid.newTx()
        .attach.SpendingValidator(validator)
        .collectFrom([utxo], redeemer)
        .pay.ToAddress(
          await lucid.wallet().address(),
          { lovelace: lovelaceAmount }
        )
        .addSigner(address)
        ;

  try {
    const unsignedTx = await tx.complete();
    const signedTx = await unsignedTx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(`Successfully refunded HTLC with transaction ID ${transactionId}.
See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}

const isPositiveNumber = (s: string) => Number.isInteger(Number(s)) && Number(s) > 0

if (Deno.args.length > 0) {
  if (Deno.args[0] === 'init') {
    if (Deno.args.length > 2 && isPositiveNumber(Deno.args[1])) {
      await initHtlc(Deno.args[1], Deno.args[2], Deno.args.length > 3 ? parseInt(Deno.args[3]) : 1);
    } else {
      console.log('Expected lovelace amount and secret as arguments.');
      console.log('Example usage: deno run -A htlc.ts init 10000000 mySecret 1');
    }
  } else if (Deno.args[0] === 'claim') {
    if (Deno.args.length > 2 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
      await claimHtlc(Deno.args[1], Deno.args[2]);
    } else {
      console.log('Expected a valid transaction ID and preimage as arguments.');
      console.log('Example usage: deno run -A htlc.ts claim 5714bd67aaeb664c3d2060ac34a33b66c2f4ec82e029b526a216024d27a8eaf5 preimage');
    }
  } else if (Deno.args[0] === 'refund') {
    if (Deno.args.length > 1 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
      await refundHtlc(Deno.args[1]);
    } else {
      console.log('Expected a valid transaction ID as the second argument.');
      console.log('Example usage: deno run -A htlc.ts refund 5714bd67aaeb664c3d2060ac34a33b66c2f4ec82e029b526a216024d27a8eaf5');
    }
  } else if (Deno.args[0] === 'prepare') {
    if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
      const files = Deno.readDirSync('.');
      const seeds = [];
      for (const file of files) {
        if (file.name.match(/wallet_[0-9]+.txt/) !== null) {
          seeds.push(file.name);
        }
      }

      if (seeds.length > 0) {
        console.log('Seed phrases already exist. Remove them before preparing new ones.');
      } else {
        await prepare(parseInt(Deno.args[1]));
      }
    } else {
      console.log('Expected a positive number (of seed phrases to prepare) as the second argument.');
      console.log('Example usage: deno run -A htlc.ts prepare 5');
    }
  } else {
    console.log('Invalid argument. Allowed arguments are "init", "claim", "refund" or "prepare".');
  }
} else {
  console.log('Expected an argument. Allowed arguments are "init", "claim", "refund" or "prepare".');
}
