import { Lucid, Koios, Data, generateSeedPhrase, validatorToAddress, Validator, fromText, getAddressDetails, LucidEvolution, TUnsafe, applyParamsToScript } from "@evolution-sdk/lucid";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };
import {
  getLucid,
  getWallet,
  sha256,
  loadStore,
  saveStore,
  showAddresses,
  checkBalances,
  transfer,
  listUtxos,
} from "./lib/utils.ts";

const HtlcRedeemer = Data.Enum([
  Data.Object({ GUESS: Data.Object({ answer: Data.Bytes() }) }),
  Data.Literal("WITHDRAW"),
]);

async function prepare (amount: number) {
  const lucid = await getLucid();

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

async function setup (params?: any[]) {
  const lucid = await getLucid();

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

async function initHtlc(lovelaceAmount: string, secret: string, walletIndex = 0, expirationSeconds = 3600) {
  const lucid = await getLucid();
  const wallet = await getWallet(lucid, walletIndex);

  const address = await wallet.address();
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
deno run -A htlc.ts claim ${txHash} <preimage> <walletIndex>`);
  } catch (error) {
    console.error("Error while submitting transaction:", error);
    Deno.exit(1);
  }
}

async function claimHtlc(transactionId: string, preimage: string, walletIndex = 1) {
  console.log(`Claiming HTLC with transaction ID: "${transactionId}" using wallet ${walletIndex}`);
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

  const wallet = await getWallet(lucid, walletIndex);

  const address = await wallet.address();
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
  console.log(`Refunding HTLC with transaction ID: "${transactionId}" using wallet ${walletIndex}`);
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

  const wallet = await getWallet(lucid, walletIndex);

  const address = await wallet.address();
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
  } else if (Deno.args[0] === 'show-addresses') {
    await showAddresses();
  } else if (Deno.args[0] === 'balances') {
    await checkBalances();
  } else if (Deno.args[0] === 'list-utxos') {
    await listUtxos();
  } else if (Deno.args[0] === 'transfer') {
    if (Deno.args.length >= 4) {
      const from = parseInt(Deno.args[1]);
      const to = parseInt(Deno.args[2]);
      const amount = Deno.args[3];
      await transfer(from, to, amount);
    } else {
      console.log('Usage: deno run -A htlc.ts transfer <fromIndex> <toIndex> <amountLovelace>');
    }
  } else {
    console.log('Invalid argument. Allowed arguments are "init", "claim", "refund", "prepare", "show-addresses", "balances", "list-utxos", or "transfer".');
  }
} else {
  console.log('Expected an argument. Allowed arguments are "init", "claim", "refund", "prepare", "show-addresses", "balances", "list-utxos", or "transfer".');
}
