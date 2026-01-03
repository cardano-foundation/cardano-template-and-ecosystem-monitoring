import { Lucid, Koios, Data, generateSeedPhrase, validatorToAddress, Validator, fromText, getAddressDetails, LucidEvolution, TUnsafe, applyParamsToScript } from "@evolution-sdk/lucid";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

const HtlcRedeemer = Data.Enum([
  Data.Object({ GUESS: Data.Object({ answer: Data.Bytes() }) }),
  Data.Literal("WITHDRAW"),
]);

const STORE_FILE = "htlc_store.json";

type StoredHtlc = {
  txHash: string;
  amount: string;
  secretHash: string;
  expiration: string;
  ownerPkh: string;
};

async function loadStore(): Promise<StoredHtlc[]> {
  try {
    const data = await Deno.readTextFile(STORE_FILE);
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveStore(store: StoredHtlc[]) {
  await Deno.writeTextFile(STORE_FILE, JSON.stringify(store, null, 2));
}

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

async function setup (params?: any[]) {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );
  selectWallet(lucid, 0);

  let script = blueprint.validators[0].compiledCode;
  if (params) {
    script = applyParamsToScript(script, params);
  }

  const validator: Validator = {
    type: "PlutusV3",
    script: script,
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

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    hex = '0' + hex;
  }
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function initHtlc(lovelaceAmount: string, secret: string, recipientIndex = 1, expirationSeconds = 3600) {
  const lucid = await Lucid(
    new Koios("https://preprod.koios.rest/api/v1"),
    "Preprod",
  );
  selectWallet(lucid, 0);

  const address = await lucid.wallet().address();
  const { paymentCredential } = getAddressDetails(address);
  const ownerPkh = paymentCredential?.hash || '';

  const secretHash = await sha256(secret);
  const expiration = BigInt(Date.now() + expirationSeconds * 1000);

  const params = [
    secretHash,
    expiration,
    ownerPkh,
  ];

  const { scriptAddress, validator } = await setup(params);

  const tx = await lucid.newTx()
      .pay.ToContract(
        scriptAddress,
        { kind: "inline", value: Data.void() },
        { lovelace: BigInt(lovelaceAmount) },
      )
      .addSigner(address)
      .complete();

  try {
    const signedTx = await tx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    
    const store = await loadStore();
    store.push({
      txHash,
      amount: lovelaceAmount,
      secretHash,
      expiration: expiration.toString(),
      ownerPkh,
    });
    await saveStore(store);

    console.log(`Successfully locked ${lovelaceAmount} lovelace to ${scriptAddress}.
See: https://preprod.cexplorer.io/tx/${txHash}`);
    console.log(`Use the following command to claim:
deno run -A htlc.ts claim ${txHash} <preimage>`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}

async function claimHtlc(transactionId: string, preimage: string, walletIndex = 1) {
  console.log(`Claiming HTLC with transaction ID: "${transactionId}"`);
  const store = await loadStore();
  const htlc = store.find((h) => h.txHash === transactionId);
  if (!htlc) {
    console.error("HTLC not found in local store.");
    return;
  }

  const params = [
    htlc.secretHash,
    BigInt(htlc.expiration),
    htlc.ownerPkh,
  ];

  const { lucid, scriptAddress, validator } = await setup(params);

  selectWallet(lucid, walletIndex);

  const address = await lucid.wallet().address();
  console.log(`Using wallet address: ${address}`);

  let utxos = [];

  try {
    const allUtxos = await lucid.utxosAt(scriptAddress);
    utxos = allUtxos.filter((u) => u.txHash === transactionId);
  } catch (error) {
    console.error(`Error fetching UTXOs for transaction ID ${transactionId}:`, error);
    return;
  }

  if (utxos.length === 0) {
    console.error(`No UTXOs found for transaction ID: ${transactionId}`);
    return;
  }

  const utxo = utxos[0];

  // Build redeemer. The on-chain contract expects a constructor 'GUESS' with the answer bytes.
    const answerHex = fromText(preimage);
    const redeemer = Data.to({ GUESS: { answer: answerHex } } as any, HtlcRedeemer as any);

  const tx = await lucid.newTx()
      .attach.SpendingValidator(validator)
      .collectFrom([utxo], redeemer)
      .validTo(Number(htlc.expiration))
      .addSigner(address)
      .complete();

  try {
    const signedTx = await tx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    console.log(`Successfully claimed HTLC with transaction ID ${transactionId}.
See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}

async function refundHtlc(transactionId: string, walletIndex = 0) {
  console.log(`Refunding HTLC with transaction ID: "${transactionId}"`);
  const store = await loadStore();
  const htlc = store.find((h) => h.txHash === transactionId);
  if (!htlc) {
    console.error("HTLC not found in local store.");
    return;
  }

  const params = [
    htlc.secretHash,
    BigInt(htlc.expiration),
    htlc.ownerPkh,
  ];

  const { lucid, scriptAddress, validator } = await setup(params);

  selectWallet(lucid, walletIndex);

  const address = await lucid.wallet().address();
  console.log(`Using wallet address: ${address}`);

  let utxos = [];

  try {
    const allUtxos = await lucid.utxosAt(scriptAddress);
    utxos = allUtxos.filter((u) => u.txHash === transactionId);
  } catch (error) {
    console.error(`Error fetching UTXOs for transaction ID ${transactionId}:`, error);
    return;
  }

  if (utxos.length === 0) {
    console.error(`No UTXOs found for transaction ID: ${transactionId}`);
    return;
  }

  const utxo = utxos[0];

  // For refund we use WITHDRAW redeemer.
    const redeemer = Data.to("WITHDRAW" as any, HtlcRedeemer as any);
    
    const tx = await lucid.newTx()
        .attach.SpendingValidator(validator)
        .collectFrom([utxo], redeemer)
        .validFrom(Number(htlc.expiration) + 1000)
        .addSigner(address)
        .complete();

  try {
    const signedTx = await tx.sign.withWallet();
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
      const amount = Deno.args[1];
      const secret = Deno.args[2];
      const recipientIndex = Deno.args.length > 3 ? parseInt(Deno.args[3]) : 1;
      const expirationSeconds = Deno.args.length > 4 ? parseInt(Deno.args[4]) : 3600;
      await initHtlc(amount, secret, recipientIndex, expirationSeconds);
    } else {
      console.log('Expected lovelace amount and secret as arguments.');
      console.log('Example usage: deno run -A htlc.ts init 10000000 mySecret 1 3600');
    }
  } else if (Deno.args[0] === 'claim') {
    if (Deno.args.length > 2 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
      const txHash = Deno.args[1];
      const preimage = Deno.args[2];
      const walletIndex = Deno.args.length > 3 ? parseInt(Deno.args[3]) : 1;
      await claimHtlc(txHash, preimage, walletIndex);
    } else {
      console.log('Expected a valid transaction ID and preimage as arguments.');
      console.log('Example usage: deno run -A htlc.ts claim 5714bd67aaeb664c3d2060ac34a33b66c2f4ec82e029b526a216024d27a8eaf5 preimage 1');
    }
  } else if (Deno.args[0] === 'refund') {
    if (Deno.args.length > 1 && Deno.args[1].match(/^[0-9a-fA-F]{64}$/)) {
      const txHash = Deno.args[1];
      const walletIndex = Deno.args.length > 2 ? parseInt(Deno.args[2]) : 0;
      await refundHtlc(txHash, walletIndex);
    } else {
      console.log('Expected a valid transaction ID as the second argument.');
      console.log('Example usage: deno run -A htlc.ts refund 5714bd67aaeb664c3d2060ac34a33b66c2f4ec82e029b526a216024d27a8eaf5 0');
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
