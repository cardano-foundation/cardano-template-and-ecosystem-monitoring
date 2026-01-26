import { 
  Data, 
  validatorToAddress, 
  Validator, 
  Assets,
  generateSeedPhrase
} from "@evolution-sdk/lucid";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };
import {
  getLucid,
  getWallet,
  showAddresses,
  checkBalances,
  transfer,
  loadStore,
  saveStore,
  addressToData,
  assetsToMValue,
  mergeAssets,
  waitForUtxo
} from "./lib/utils.ts";
import { 
  EscrowDatum, 
  EscrowRedeemer 
} from "./types.ts";

/**
 * Setup Lucid and the Validator
 */
async function setup() {
  const lucid = await getLucid();
  const script = blueprint.validators[0].compiledCode;
  const validator: Validator = {
    type: "PlutusV3",
    script: script,
  };
  const scriptAddress = validatorToAddress("Preprod", validator);

  return { lucid, scriptAddress, validator };
}

/**
 * Step 1: Initiator locks assets into the Escrow Contract
 */
async function initiateEscrow(walletIndex: number, assets: Assets) {
  const { lucid, scriptAddress } = await setup();
  const wallet = await getWallet(lucid, walletIndex);
  const address = await wallet.address();

  const datum = Data.to(
    {
      Initiation: {
        initiator: addressToData(address),
        initiator_assets: assetsToMValue(assets),
      },
    } as any,
    EscrowDatum
  );

  const tx = await lucid.newTx()
    .pay.ToContract(scriptAddress, { kind: "inline", value: datum }, assets)
    .addSigner(address)
    .complete();

  try {
    const signedTx = await tx.sign.withWallet();
    const txHash = await (await signedTx.complete()).submit();
    
    const store = await loadStore();
    store.push({
      txHash,
      initiator: address,
      initiatorAssets: assets,
      state: "Initiation",
    });
    await saveStore(store);

    console.log(`Escrow initiated. TxHash: ${txHash}`);
    console.log(`See: https://preprod.cexplorer.io/tx/${txHash}`);
  } catch (error) {
    console.error("Error while initiating escrow:", error);
  }
}

/**
 * Step 2: Recipient deposits assets to move the contract to ActiveEscrow state
 */
async function depositEscrow(txHash: string, walletIndex: number, recipientAssets: Assets) {
  const { lucid, scriptAddress, validator } = await setup();
  const wallet = await getWallet(lucid, walletIndex);
  const recipientAddr = await wallet.address();

  const utxo = await waitForUtxo(lucid, txHash, scriptAddress);
  if (!utxo.datum) throw new Error("UTXO missing datum");

  const inputDatum = Data.from(utxo.datum, EscrowDatum) as any;
  if (!("Initiation" in inputDatum)) throw new Error("Contract not in Initiation state");

  const { initiator, initiator_assets } = inputDatum.Initiation;

  const redeemer = Data.to(
    {
      RecipientDeposit: {
        recipient: addressToData(recipientAddr),
        recipient_assets: assetsToMValue(recipientAssets),
      },
    } as any,
    EscrowRedeemer
  );

  const outputDatum = Data.to(
    {
      ActiveEscrow: {
        initiator,
        recipient: addressToData(recipientAddr),
        initiator_assets,
        recipient_assets: assetsToMValue(recipientAssets),
      },
    } as any,
    EscrowDatum
  );

  const totalValue = mergeAssets(utxo.assets, recipientAssets);

  const tx = await lucid.newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .pay.ToContract(scriptAddress, { kind: "inline", value: outputDatum }, totalValue)
    .addSigner(recipientAddr)
    .validTo(Date.now() + 100000)
    .complete();

  try {
    const signedTx = await tx.sign.withWallet();
    const resultHash = await (await signedTx.complete()).submit();

    const store = await loadStore();
    const escrow = store.find(e => e.txHash === txHash);
    if (escrow) {
      escrow.txHash = resultHash;
      escrow.recipient = recipientAddr;
      escrow.recipientAssets = recipientAssets;
      escrow.state = "ActiveEscrow";
      await saveStore(store);
    }

    console.log(`Recipient deposited. State is now Active. TxHash: ${resultHash}`);
    console.log(`See: https://preprod.cexplorer.io/tx/${resultHash}`);
  } catch (error) {
    console.error("Error while depositing to escrow:", error);
  }
}

/**
 * Step 3: Finalize trade (Swap assets to respective parties)
 */
async function completeTrade(txHash: string, initiatorWalletIndex: number, recipientWalletIndex: number) {
  const { lucid, scriptAddress, validator } = await setup();
  
  // Select a wallet to pay fees (e.g. initiator)
  await getWallet(lucid, initiatorWalletIndex);

  const utxo = await waitForUtxo(lucid, txHash, scriptAddress);
  if (!utxo.datum) throw new Error("UTXO missing datum");

  const datum = Data.from(utxo.datum, EscrowDatum);
  if (!("ActiveEscrow" in datum)) throw new Error("Escrow is not active");

  const redeemer = Data.to("CompleteTrade", EscrowRedeemer as any);

  const store = await loadStore();
  const escrow = store.find(e => e.txHash === txHash);
  if (!escrow || !escrow.recipient) throw new Error("Escrow not found in store or recipient missing");

  const tx = await lucid.newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .pay.ToAddress(escrow.initiator, escrow.recipientAssets!)
    .pay.ToAddress(escrow.recipient, escrow.initiatorAssets)
    .addSigner(escrow.initiator)
    .addSigner(escrow.recipient)
    .complete();

  try {
    // Note: This requires both parties to sign the transaction
    const txComplete = tx;

    const txCBOR = txComplete.toCBOR();

    await getWallet(lucid, initiatorWalletIndex);
    const witness1 = await lucid.fromTx(txCBOR).partialSign.withWallet();
    
    await getWallet(lucid, recipientWalletIndex);
    const witness2 = await lucid.fromTx(txCBOR).partialSign.withWallet();
    
    const signedTx = await lucid.fromTx(txCBOR).assemble([witness1, witness2]).complete();
    const resultHash = await signedTx.submit();

    // Remove from store as it's completed
    const newStore = store.filter(e => e.txHash !== txHash);
    await saveStore(newStore);

    console.log(`Trade Completed! Assets Swapped. TxHash: ${resultHash}`);
    console.log(`See: https://preprod.cexplorer.io/tx/${resultHash}`);
  } catch (error) {
    console.error("Error while completing trade:", error);
  }
}

/**
 * Step 4: Cancel Trade (Refund assets)
 */
async function cancelTrade(txHash: string, walletIndex: number) {
  const { lucid, scriptAddress, validator } = await setup();
  const wallet = await getWallet(lucid, walletIndex);
  const signerAddr = await wallet.address();

  const utxo = await waitForUtxo(lucid, txHash, scriptAddress);
  if (!utxo.datum) throw new Error("UTXO missing datum");

  const datum = Data.from(utxo.datum, EscrowDatum);
  const redeemer = Data.to("CancelTrade", EscrowRedeemer as any);

  const store = await loadStore();
  const escrow = store.find(e => e.txHash === txHash);
  if (!escrow) throw new Error("Escrow not found in store");

  const tx = lucid.newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .addSigner(signerAddr);

  if ("Initiation" in datum) {
    tx.pay.ToAddress(escrow.initiator, utxo.assets);
  } else if ("ActiveEscrow" in datum) {
    tx.pay.ToAddress(escrow.initiator, escrow.initiatorAssets)
      .pay.ToAddress(escrow.recipient!, escrow.recipientAssets!);
  }

  try {
    const finishedTx = await tx.complete();
    const signedTx = await finishedTx.sign.withWallet();
    const resultHash = await (await signedTx.complete()).submit();

    // Remove from store
    const newStore = store.filter(e => e.txHash !== txHash);
    await saveStore(newStore);

    console.log(`Trade Cancelled. Funds Refunded. TxHash: ${resultHash}`);
    console.log(`See: https://preprod.cexplorer.io/tx/${resultHash}`);
  } catch (error) {
    console.error("Error while cancelling trade:", error);
  }
}

/**
 * List all escrow UTXOs from the store
 */
async function listUtxos() {
  const { lucid, scriptAddress } = await setup();
  const store = await loadStore();
  
  if (store.length === 0) {
    console.log("No escrows found in store.");
    return;
  }

  console.log(`Checking escrows at ${scriptAddress}...`);
  const utxos = await lucid.utxosAt(scriptAddress);

  for (const escrow of store) {
    console.log(`--- Escrow ${escrow.txHash} ---`);
    console.log(`State: ${escrow.state}`);
    console.log(`Initiator: ${escrow.initiator}`);
    if (escrow.recipient) console.log(`Recipient: ${escrow.recipient}`);
    
    const utxo = utxos.find((u) => u.txHash === escrow.txHash);

    if (utxo) {
      console.log(`Status: ON-CHAIN (UTXO found)`);
      console.log(`Assets: ${JSON.stringify(utxo.assets, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
    } else {
      console.log(`Status: SPENT or NOT FOUND`);
    }
    console.log("");
  }
}

/**
 * Prepare wallets for testing
 */
async function prepare(amount: number) {
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

const isPositiveNumber = (s: string) => Number.isInteger(Number(s)) && Number(s) > 0;

if (Deno.args.length > 0) {
  const command = Deno.args[0];
  
  switch (command) {
    case "prepare":
      if (Deno.args.length > 1 && isPositiveNumber(Deno.args[1])) {
        await prepare(parseInt(Deno.args[1]));
      } else {
        console.log("Usage: deno run -A escrow.ts prepare <amount>");
      }
      break;

    case "initiate":
      // Example: deno run -A escrow.ts initiate 0 10000000
      if (Deno.args.length > 2 && isPositiveNumber(Deno.args[2])) {
        const walletIdx = parseInt(Deno.args[1]);
        const lovelace = BigInt(Deno.args[2]);
        await initiateEscrow(walletIdx, { lovelace });
      } else {
        console.log("Usage: deno run -A escrow.ts initiate <walletIndex> <lovelace>");
      }
      break;

    case "deposit":
      // Example: deno run -A escrow.ts deposit <txHash> 1 5000000
      if (Deno.args.length > 3 && isPositiveNumber(Deno.args[3])) {
        const txHash = Deno.args[1];
        const walletIdx = parseInt(Deno.args[2]);
        const lovelace = BigInt(Deno.args[3]);
        await depositEscrow(txHash, walletIdx, { lovelace });
      } else {
        console.log("Usage: deno run -A escrow.ts deposit <txHash> <walletIndex> <lovelace>");
      }
      break;

    case "complete":
      if (Deno.args.length > 1) {
        await completeTrade(Deno.args[1], 0, 1);
      } else {
        console.log("Usage: deno run -A escrow.ts complete <txHash>");
      }
      break;

    case "cancel":
      if (Deno.args.length > 2) {
        await cancelTrade(Deno.args[1], parseInt(Deno.args[2]));
      } else {
        console.log("Usage: deno run -A escrow.ts cancel <txHash> <walletIndex>");
      }
      break;

    case "show-addresses":
      await showAddresses();
      break;

    case "balances":
      await checkBalances();
      break;

    case "list-utxos":
      await listUtxos();
      break;

    case "transfer":
      if (Deno.args.length >= 4) {
        const from = parseInt(Deno.args[1]);
        const to = parseInt(Deno.args[2]);
        const amount = Deno.args[3];
        await transfer(from, to, amount);
      } else {
        console.log('Usage: deno run -A escrow.ts transfer <fromIndex> <toIndex> <amountLovelace>');
      }
      break;

    default:
      console.log("Commands: prepare, initiate, deposit, complete, cancel, show-addresses, balances, list-utxos, transfer");
  }
} else {
  console.log("Expected an argument. Commands: prepare, initiate, deposit, complete, cancel, show-addresses, balances, list-utxos, transfer");
}
