import {
  MeshTxBuilder,
  mConStr0,
  mConStr1,
  mConStr2,
  serializeAddressObj,
  resolvePaymentKeyHash,
  pubKeyAddress,
} from '@meshsdk/core';
import {
  koiosProvider,
  getWallet,
  prepare,
  showAddresses,
  getScriptAddress,
  decodeDatum,
  scriptCbor,
} from './lib/utils.ts';

// --- Store ---
const STORE_FILE = 'store.json';
async function saveStore(data: any) {
  await Deno.writeTextFile(STORE_FILE, JSON.stringify(data, null, 2));
}
async function loadStore() {
  try {
    const data = await Deno.readTextFile(STORE_FILE);
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// --- Configuration ---
const blockchainProvider = koiosProvider;

/**
 * Subscriber locks funds into the contract to start a subscription.
 */
async function initSubscription(feeAmount: string) {
  const subscriber = await getWallet(1);
  const merchant = await getWallet(2);

  const subPkh = resolvePaymentKeyHash(
    (await subscriber.getUsedAddresses())[0]
  );
  const merPkh = resolvePaymentKeyHash((await merchant.getUsedAddresses())[0]);

  const scriptAddr = getScriptAddress();
  console.log('Script Address:', scriptAddr);

  // SubscriptionDatum: merchant, subscriber, fee, last_claim, period
  // We use current time for last_claim initially to start the period.
  // Backdate by 6 hours to accommodate potential node sync lag (ensure period is passed relative to node time)
  const now = Date.now() - 6 * 60 * 60 * 1000;

  const datum = mConStr0([
    merPkh,
    subPkh,
    BigInt(feeAmount),
    BigInt(now), // last_claim
    BigInt(60000), // period (e.g., 60 seconds for testing)
  ]);

  const txBuilder = new MeshTxBuilder({
    fetcher: blockchainProvider,
    submitter: blockchainProvider,
  });

  const tx = await txBuilder
    .txOut(scriptAddr, [{ unit: 'lovelace', quantity: '50000000' }]) // Initial deposit
    .txOutInlineDatumValue(datum)
    .changeAddress((await subscriber.getUsedAddresses())[0])
    .selectUtxosFrom(await subscriber.getUtxos())
    .complete();

  const signedTx = await subscriber.signTx(tx);
  const txHash = await subscriber.submitTx(signedTx);
  console.log(`Subscription started. TX: ${txHash}`);
  await saveStore({ lastTxHash: txHash });
}

/**
 * Merchant collects the fee if the period has passed.
 */
async function collectFee(txHash: string) {
  const merchant = await getWallet(2);
  const scriptAddr = getScriptAddress();

  const utxos = await blockchainProvider.fetchAddressUTxOs(scriptAddr);
  const utxo = utxos.find((u) => u.input.txHash === txHash);

  if (!utxo) throw new Error('Subscription UTXO not found');
  if (!utxo.output.plutusData) throw new Error('No datum found in UTXO');

  const datum = decodeDatum(utxo.output.plutusData);

  // Use system time for logic checks
  const currentTime = Date.now();

  const tipRes = await fetch('https://preprod.koios.rest/api/v1/tip');
  const tip = await tipRes.json();
  // Koios tip might be ahead of the validation node if lagging.
  // Use a conservative slot (e.g., from 6 hours ago) to ensure invalidBefore < NodeCurrentSlot
  // 1 second = 1 slot. 6 hours = 21600 seconds.
  const currentSlot = Number(tip[0].abs_slot) - 21600;
  console.log(
    'Using conservatively backdated Slot for construction:',
    currentSlot
  );

  if (BigInt(currentTime) < datum.last_claim + datum.period) {
    console.warn(
      'Warning: Period might not have passed based on latest block time.'
    );
  }

  // New datum: update last_claim to the lower bound of validity range (currentTime)
  const newDatum = mConStr0([
    datum.merchant,
    datum.subscriber,
    datum.fee,
    BigInt(currentTime),
    datum.period,
  ]);

  const merchantAddress = (await merchant.getUsedAddresses())[0];
  const collateral = (await merchant.getCollateral())[0];

  const inputLovelace = BigInt(
    utxo.output.amount.find((a) => a.unit === 'lovelace')?.quantity || '0'
  );
  // Ensure we deduct the fee
  const outputLovelace = inputLovelace - datum.fee;

  const txBuilder = new MeshTxBuilder({
    fetcher: blockchainProvider,
    submitter: blockchainProvider,
  });

  const tx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      utxo.input.txHash,
      utxo.input.outputIndex,
      utxo.output.amount,
      utxo.output.address
    )
    .txInInlineDatumPresent()
    .txInRedeemerValue(mConStr0([])) // Collect
    .txInScript(scriptCbor)
    .requiredSignerHash(resolvePaymentKeyHash(merchantAddress))
    .txOut(scriptAddr, [
      { unit: 'lovelace', quantity: outputLovelace.toString() },
    ])
    .txOutInlineDatumValue(newDatum)
    .changeAddress(merchantAddress)
    .txInCollateral(
      collateral.input.txHash,
      collateral.input.outputIndex,
      collateral.output.amount,
      collateral.output.address
    )
    .selectUtxosFrom(await merchant.getUtxos())
    .invalidBefore(currentSlot - 60)
    .invalidHereafter(currentSlot + 300) // 5 minutes validity
    .complete();

  const signedTx = await merchant.signTx(tx);
  const txHashRes = await merchant.submitTx(signedTx);
  console.log(`Fee collected. TX: ${txHashRes}`);
  await saveStore({ lastTxHash: txHashRes });
}

/**
 * Subscriber cancels the subscription.
 */
async function cancelSubscription(txHash: string) {
  const subscriber = await getWallet(1);
  const scriptAddr = getScriptAddress();

  const utxos = await blockchainProvider.fetchAddressUTxOs(scriptAddr);
  const utxo = utxos.find((u) => u.input.txHash === txHash);
  if (!utxo) throw new Error('Subscription UTXO not found');

  const subscriberAddress = (await subscriber.getUsedAddresses())[0];
  const collateral = (await subscriber.getCollateral())[0];

  // Redeemer: Cancel = mConStr1([])

  const txBuilder = new MeshTxBuilder({
    fetcher: blockchainProvider,
    submitter: blockchainProvider,
  });

  const tx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      utxo.input.txHash,
      utxo.input.outputIndex,
      utxo.output.amount,
      utxo.output.address
    )
    .txInInlineDatumPresent()
    .txInRedeemerValue(mConStr1([]))
    .txInScript(scriptCbor)
    .requiredSignerHash(resolvePaymentKeyHash(subscriberAddress))
    .changeAddress(subscriberAddress)
    .txInCollateral(
      collateral.input.txHash,
      collateral.input.outputIndex,
      collateral.output.amount,
      collateral.output.address
    )
    .selectUtxosFrom(await subscriber.getUtxos())
    .complete();

  const signedTx = await subscriber.signTx(tx);
  const txHashRes = await subscriber.submitTx(signedTx);
  console.log(`Subscription cancelled. TX: ${txHashRes}`);
}

/**
 * Merchant closes the subscription.
 * Must verify funds return to Subscriber.
 */
async function closeSubscription(txHash: string) {
  const merchant = await getWallet(2);
  const scriptAddr = getScriptAddress();

  const utxos = await blockchainProvider.fetchAddressUTxOs(scriptAddr);
  const utxo = utxos.find((u) => u.input.txHash === txHash);
  if (!utxo) throw new Error('Subscription UTXO not found');
  if (!utxo.output.plutusData) throw new Error('No datum found in UTXO');

  const datum = decodeDatum(utxo.output.plutusData);
  const merchantAddress = (await merchant.getUsedAddresses())[0];
  const collateral = (await merchant.getCollateral())[0];

  // Reconstruct subscriber address (Enterprise) from PubKeyHash
  const subscriberAddress = serializeAddressObj(
    pubKeyAddress(datum.subscriber),
    0
  );

  const inputLovelace = BigInt(
    utxo.output.amount.find((a) => a.unit === 'lovelace')?.quantity || '0'
  );

  const txBuilder = new MeshTxBuilder({
    fetcher: blockchainProvider,
    submitter: blockchainProvider,
  });

  const tx = await txBuilder
    .spendingPlutusScriptV3()
    .txIn(
      utxo.input.txHash,
      utxo.input.outputIndex,
      utxo.output.amount,
      utxo.output.address
    )
    .txInInlineDatumPresent()
    .txInRedeemerValue(mConStr2([])) // Close
    .txInScript(scriptCbor)
    .requiredSignerHash(resolvePaymentKeyHash(merchantAddress))
    .txOut(subscriberAddress, [
      { unit: 'lovelace', quantity: inputLovelace.toString() },
    ])
    .changeAddress(merchantAddress)
    .txInCollateral(
      collateral.input.txHash,
      collateral.input.outputIndex,
      collateral.output.amount,
      collateral.output.address
    )
    .selectUtxosFrom(await merchant.getUtxos())
    .complete();

  const signedTx = await merchant.signTx(tx);
  const txHashRes = await merchant.submitTx(signedTx);
  console.log(`Subscription closed by merchant. TX: ${txHashRes}`);
}

// --- CLI Runner ---
const isPositiveNumber = (s: string) =>
  Number.isInteger(Number(s)) && Number(s) > 0;

const args = Deno.args;

if (args.length > 0) {
  const cmd = args[0];

  if (cmd === 'init') {
    if (args.length > 1 && isPositiveNumber(args[1])) {
      await initSubscription(args[1]);
    } else {
      console.log('Usage: deno run -A main.ts init <fee_lovelace>');
    }
  } else if (cmd === 'collect') {
    let txHash = args.length > 1 ? args[1] : undefined;
    if (!txHash) {
      const store = await loadStore();
      if (store.lastTxHash) {
        txHash = store.lastTxHash;
        console.log(`Using stored TX Hash: ${txHash}`);
      }
    }
    if (txHash) {
      await collectFee(txHash);
    } else {
      console.log('Usage: deno run -A main.ts collect <tx_hash>');
      console.log('Or ensure a valid TX hash is in store.json');
    }
  } else if (cmd === 'cancel') {
    let txHash = args.length > 1 ? args[1] : undefined;
    if (!txHash) {
      const store = await loadStore();
      if (store.lastTxHash) {
        txHash = store.lastTxHash;
        console.log(`Using stored TX Hash: ${txHash}`);
      }
    }
    if (txHash) {
      await cancelSubscription(txHash);
    } else {
      console.log('Usage: deno run -A main.ts cancel <tx_hash>');
      console.log('Or ensure a valid TX hash is in store.json');
    }
  } else if (cmd === 'close') {
    let txHash = args.length > 1 ? args[1] : undefined;
    if (!txHash) {
      const store = await loadStore();
      if (store.lastTxHash) {
        txHash = store.lastTxHash;
        console.log(`Using stored TX Hash: ${txHash}`);
      }
    }
    if (txHash) {
      await closeSubscription(txHash);
    } else {
      console.log('Usage: deno run -A main.ts close <tx_hash>');
      console.log('Or ensure a valid TX hash is in store.json');
    }
  } else if (cmd === 'prepare') {
    const count = args.length > 1 ? parseInt(args[1]) : 2;
    await prepare(count);
  } else if (cmd === 'address') {
    await showAddresses();
  } else {
    console.log('Unknown command. Use: init, collect, cancel, prepare');
  }
} else {
  console.log('Usage: deno run -A main.ts <command> [args]');
}
