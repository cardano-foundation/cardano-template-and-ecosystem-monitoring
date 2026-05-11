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
// Simple transfer. Parameterised PlutusV3 spend validator that hard-codes
// the recipient VKH; only that key's signature can unlock the locked UTxO.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const;
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
    } catch {}
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
  // Funder is the next caller — wait for its own new change UTxO so lucid
  // doesn't re-select the spent input.
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

  // account 0 = sender / funder ; 1 = recipient
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
