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
  isPositiveNumber,
} from './lib/utils.ts';

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
  const now = Date.now();

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
    // .invalidBefore(currentSlot)
    // .invalidHereafter(currentSlot + 300) // 5 minutes validity
    .complete();

  const signedTx = await merchant.signTx(tx);
  const txHashRes = await merchant.submitTx(signedTx);
  console.log(`Fee collected. TX: ${txHashRes}`);
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
    if (args.length > 1) {
      await collectFee(args[1]);
    } else {
      console.log('Usage: deno run -A main.ts collect <tx_hash>');
    }
  } else if (cmd === 'cancel') {
    if (args.length > 1) {
      await cancelSubscription(args[1]);
    } else {
      console.log('Usage: deno run -A main.ts cancel <tx_hash>');
    }
  } else if (cmd === 'close') {
    if (args.length > 1) {
      await closeSubscription(args[1]);
    } else {
      console.log('Usage: deno run -A main.ts close <tx_hash>');
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
