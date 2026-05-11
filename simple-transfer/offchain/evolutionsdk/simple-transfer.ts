import {
  Blockfrost,
  Data,
  Lucid,
  LucidEvolution,
  applyParamsToScript,
  SpendingValidator,
  getAddressDetails,
  validatorToAddress,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Simple-transfer scenario — Evolution SDK targeting yaci-devkit.
//
// Validator: lock funds for a recipient (by VKH). Only the recipient can spend
// after `from_verification_key` signs (their VKH must match the parameter).
//
// Scenario: lock as account 0 (sender) for the recipient account 1, then claim
// as account 1.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const; // yaci-devkit emulates the Preprod magic.
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

async function lucidAt(accountIndex: number): Promise<LucidEvolution> {
  const lucid = await Lucid(new Blockfrost(YACI_URL, "Dummy Key"), NETWORK);
  lucid.selectWallet.fromSeed(TEST_MNEMONIC, { accountIndex });
  return lucid;
}

async function waitForUtxosAt(
  lucid: LucidEvolution,
  address: string,
  minCount: number,
  timeoutSec = 60,
): Promise<void> {
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await lucid.utxosAt(address);
      if (u.length >= minCount) return;
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${address}`);
}

function buildScript(receiverVkh: string): SpendingValidator {
  const validator = blueprint.validators.find(
    (v) => v.title === "simple_transfer.simpleTransfer.spend",
  );
  if (!validator) throw new Error("Validator not found in plutus.json");
  return {
    type: "PlutusV3",
    script: applyParamsToScript(validator.compiledCode, [receiverVkh]),
  };
}

async function fundFromIndex0(targetAddress: string, lovelace: bigint) {
  const lucid = await lucidAt(0);
  const tx = await lucid
    .newTx()
    .pay.ToAddress(targetAddress, { lovelace })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Funded ${targetAddress} with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxosAt(lucid, targetAddress, 1, 60);
  // The funder (account 0) will be the next caller — wait for its new change
  // UTxO to be indexed, otherwise lucid may re-select the consumed input.
  const funderAddr = await lucid.wallet().address();
  for (let i = 0; i < 60; i++) {
    const u = await lucid.utxosAt(funderAddr);
    if (u.some((x) => x.txHash === txHash)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function lock(senderAccount: number, receiverAddress: string, lovelace: bigint) {
  const lucid = await lucidAt(senderAccount);
  const receiverVkh = getAddressDetails(receiverAddress).paymentCredential?.hash;
  if (!receiverVkh) throw new Error("Invalid receiver address");

  const script = buildScript(receiverVkh);
  const scriptAddress = validatorToAddress(NETWORK, script);

  const tx = await lucid
    .newTx()
    .pay.ToAddress(scriptAddress, { lovelace })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`LOCK ok. ${lovelace} lovelace to ${scriptAddress}. tx=${txHash}`);
  return scriptAddress;
}

async function claim(receiverAccount: number) {
  const lucid = await lucidAt(receiverAccount);
  const address = await lucid.wallet().address();
  const pkh = getAddressDetails(address).paymentCredential?.hash;
  if (!pkh) throw new Error("Could not get receiver PKH");

  const script = buildScript(pkh);
  const scriptAddress = validatorToAddress(NETWORK, script);
  await waitForUtxosAt(lucid, scriptAddress, 1, 60);

  const utxos = await lucid.utxosAt(scriptAddress);
  if (utxos.length === 0) throw new Error("No UTxOs to claim");

  const tx = await lucid
    .newTx()
    .collectFrom(utxos, Data.void())
    .attach.SpendingValidator(script)
    .addSigner(address)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`CLAIM ok. ${utxos.length} UTxO(s). tx=${txHash}`);
}

async function runScenario() {
  console.log("=== simple-transfer scenario: lock → claim ===");

  // Account 1 is the recipient. Fund it from account 0 so it can pay claim fees.
  const recipientLucid = await lucidAt(1);
  const recipientAddress = await recipientLucid.wallet().address();
  await fundFromIndex0(recipientAddress, 25_000_000n);

  await lock(0, recipientAddress, 10_000_000n);
  await claim(1);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
