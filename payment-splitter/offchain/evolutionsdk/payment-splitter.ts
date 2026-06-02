import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  applyParamsToScript,
  getAddressDetails,
  validatorToAddress,
  type LucidEvolution,
  type Validator,
} from "@evolution-sdk/lucid";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// ----------------------------------------------------------------------------
// Payment splitter. Parameterised PlutusV3 spend validator carrying the
// payee VKH list; spending must produce exactly one equal-share output per
// payee. Account 0 (the payer) must itself be a payee, otherwise lucid's
// change output would be flagged as an unexpected extra credential.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const PAYEE_COUNT = 5;
const PAYEE_INDICES = [0, 1, 2, 3, 4];

async function lucidAt(accountIndex: number): Promise<LucidEvolution> {
  const lucid = await Lucid(new Blockfrost(YACI_URL, "Dummy Key"), NETWORK);
  lucid.selectWallet.fromSeed(TEST_MNEMONIC, { accountIndex });
  return lucid;
}

async function vkhOf(accountIndex: number): Promise<string> {
  const l = await lucidAt(accountIndex);
  return getAddressDetails(await l.wallet().address()).paymentCredential!.hash;
}

async function addrOf(accountIndex: number): Promise<string> {
  const l = await lucidAt(accountIndex);
  return await l.wallet().address();
}

async function loadPayeeVkhs(): Promise<string[]> {
  return await Promise.all(PAYEE_INDICES.map((i) => vkhOf(i)));
}

async function setup(payerAccount: number) {
  const lucid = await lucidAt(payerAccount);
  const payeeVkhs = await loadPayeeVkhs();
  const script = applyParamsToScript(blueprint.validators[0].compiledCode, [payeeVkhs]);
  const validator: Validator = { type: "PlutusV3", script };
  return {
    lucid,
    validator,
    scriptAddress: validatorToAddress(NETWORK, validator),
    payeeVkhs,
  };
}

async function lock(amount: bigint): Promise<string> {
  const { lucid, scriptAddress, payeeVkhs } = await setup(0);
  const datum = Data.to(new Constr(0, [payeeVkhs[0]]));
  const tx = await lucid
    .newTx()
    .pay.ToContract(scriptAddress, { kind: "inline", value: datum }, { lovelace: amount })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`LOCK ok. ${amount} lovelace. tx=${txHash}`);
  return txHash;
}

async function payout() {
  const { lucid, validator, scriptAddress } = await setup(0);
  let utxos: Awaited<ReturnType<LucidEvolution["utxosAt"]>> = [];
  for (let i = 0; i < 60; i++) {
    utxos = await lucid.utxosAt(scriptAddress);
    if (utxos.length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (utxos.length === 0) throw new Error("No script UTxOs to spend");
  const utxo = utxos[0];

  const totalLovelace = utxo.assets.lovelace ?? 0n;
  const sharePerPayee = totalLovelace / BigInt(PAYEE_COUNT);
  const redeemer = Data.to(new Constr(0, [
    Array.from(new TextEncoder().encode("payout"))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  ]));

  let txBuilder = lucid
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator);
  for (const i of PAYEE_INDICES) {
    const payeeAddr = await addrOf(i);
    txBuilder = txBuilder.pay.ToAddress(payeeAddr, { lovelace: sharePerPayee });
  }
  const tx = await txBuilder.complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`PAYOUT ok. share=${sharePerPayee} tx=${txHash}`);
}

async function runScenario() {
  console.log("=== payment-splitter scenario: lock → payout ===");
  await lock(50_000_000n);
  await new Promise((r) => setTimeout(r, 3000));
  await payout();
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
