import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  applyParamsToScript,
  generateSeedPhrase,
  getAddressDetails,
  toUnit,
  validatorToAddress,
  validatorToRewardAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
} from "@evolution-sdk/lucid";
import { encodeHex } from "@std/encoding/hex";
import { sha3_256 } from "@noble/hashes/sha3.js";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };
import { ProxyDatum, WithdrawalRedeemerV1, WithdrawalRedeemerV2 } from "./types.ts";

// ----------------------------------------------------------------------------
// Upgradable proxy. Proxy state lives at a script address with a datum
// pointing at the active logic script's hash; the logic is invoked via a
// zero-value stake withdrawal, so each logic version owns a stake address
// that has to be registered before its first use.
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
async function lucidFromSeed(seed: string): Promise<LucidEvolution> {
  const lucid = await Lucid(new Blockfrost(YACI_URL, "Dummy Key"), NETWORK);
  lucid.selectWallet.fromSeed(seed);
  return lucid;
}

async function waitForUtxosAt(
  lucid: LucidEvolution,
  address: string,
  minCount: number,
  timeoutSec = 60,
) {
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await lucid.utxosAt(address);
      if (u.length >= minCount) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${address}`);
}

async function fundFromIndex0(targetAddress: string, lovelace: bigint) {
  const lucid = await lucidAt(0);
  const tx = await lucid.newTx().pay.ToAddress(targetAddress, { lovelace }).complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Funded ${targetAddress.slice(0, 20)}… with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxosAt(lucid, targetAddress, 1, 60);
  await new Promise((r) => setTimeout(r, 2000));
}

function getStateTokenName(txHash: string, outputIndex: number): string {
  const txHashBytes = new Uint8Array(txHash.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const outputIndexBytes = new TextEncoder().encode(outputIndex.toString());
  const buf = new Uint8Array(txHashBytes.length + outputIndexBytes.length);
  buf.set(txHashBytes, 0);
  buf.set(outputIndexBytes, txHashBytes.length);
  return encodeHex(new Uint8Array(sha3_256(buf)));
}

function buildLogicV1Script(proxyPolicyId: string): Script {
  return {
    type: "PlutusV3",
    script: applyParamsToScript(
      blueprint.validators.find((v) => v.title.startsWith("script_logic_v_1"))!.compiledCode,
      [proxyPolicyId],
    ),
  };
}
function buildLogicV2Script(proxyPolicyId: string): Script {
  return {
    type: "PlutusV3",
    script: applyParamsToScript(
      blueprint.validators.find((v) => v.title.startsWith("script_logic_v_2"))!.compiledCode,
      [proxyPolicyId],
    ),
  };
}

async function initProxy(lucid: LucidEvolution): Promise<{ tokenUnit: string }> {
  const ownerAddr = await lucid.wallet().address();
  const ownerVkh = getAddressDetails(ownerAddr).paymentCredential!.hash;
  const utxos = await lucid.utxosAt(ownerAddr);
  const seedUtxo = utxos.find((u) => (u.assets.lovelace ?? 0n) > 5_000_000n);
  if (!seedUtxo) throw new Error("No seed UTxO with enough ada");

  const outputReference = new Constr(0, [seedUtxo.txHash, BigInt(seedUtxo.outputIndex)]);
  const proxyValidator: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(
      blueprint.validators.find((v) => v.title.startsWith("proxy"))!.compiledCode,
      [outputReference],
    ),
  };
  const proxyPolicyId = validatorToScriptHash(proxyValidator);
  const logicV1 = buildLogicV1Script(proxyPolicyId);
  const datum = Data.to(
    { script_pointer: validatorToScriptHash(logicV1), script_owner: ownerVkh },
    ProxyDatum,
  );
  const redeemer = Data.to(new Constr(1, []));
  const stateTokenName = getStateTokenName(seedUtxo.txHash, seedUtxo.outputIndex);
  const tokenUnit = toUnit(proxyPolicyId, stateTokenName);

  const tx = await lucid
    .newTx()
    .collectFrom([seedUtxo], Data.void())
    .mintAssets({ [tokenUnit]: 1n }, redeemer)
    .register.Stake(validatorToRewardAddress(NETWORK, logicV1))
    .pay.ToContract(
      validatorToAddress(NETWORK, proxyValidator),
      { kind: "inline", value: datum },
      { [tokenUnit]: 1n },
      proxyValidator,
    )
    .attach.MintingPolicy(proxyValidator)
    .attach.CertificateValidator(logicV1)
    .addSigner(ownerAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`INIT ok. proxy=${proxyPolicyId.slice(0, 16)}… tx=${txHash}`);
  return { tokenUnit };
}

async function mintProxyToken(lucid: LucidEvolution, tokenUnit: string) {
  const ownerAddr = await lucid.wallet().address();
  let utxo: Awaited<ReturnType<LucidEvolution["utxoByUnit"]>> | undefined;
  for (let i = 0; i < 60; i++) {
    try {
      utxo = await lucid.utxoByUnit(tokenUnit);
      if (utxo) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!utxo) throw new Error("Proxy state UTxO not indexed");

  const proxyValidator = utxo.scriptRef!;
  const proxyPolicyId = validatorToScriptHash(proxyValidator);
  const logicHash = Data.from(utxo.datum!, ProxyDatum).script_pointer;
  const v1 = buildLogicV1Script(proxyPolicyId);
  const v2 = buildLogicV2Script(proxyPolicyId);
  const isV1 = logicHash === validatorToScriptHash(v1);
  const logicValidator = isV1 ? v1 : v2;

  const redeemer = Data.to(new Constr(0, []));
  const withdrawRedeemer = isV1
    ? Data.to({ token_name: encodeHex("ProxyMintToken"), password: encodeHex("NoPassword") }, WithdrawalRedeemerV1)
    : Data.to({ invalid_token_name: encodeHex("InvalidToken") }, WithdrawalRedeemerV2);

  // readFrom passes the proxy state UTxO as a reference input so the proxy
  // mint policy can read script_pointer (and require it matches the logic
  // validator hash being withdrawn-from) without spending the state.
  const tx = await lucid
    .newTx()
    .readFrom([utxo])
    .mintAssets({ [toUnit(proxyPolicyId, encodeHex("ProxyMintToken"))]: 1n }, redeemer)
    .withdraw(validatorToRewardAddress(NETWORK, logicValidator), 0n, withdrawRedeemer)
    .attach.MintingPolicy(proxyValidator)
    .attach.WithdrawalValidator(logicValidator)
    .addSigner(ownerAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`MINT (v${isV1 ? 1 : 2}) ok. tx=${txHash}`);
}

async function changeVersion(lucid: LucidEvolution, tokenUnit: string) {
  const ownerAddr = await lucid.wallet().address();
  const ownerVkh = getAddressDetails(ownerAddr).paymentCredential!.hash;
  const utxo = await lucid.utxoByUnit(tokenUnit);
  if (!utxo) throw new Error("Proxy state UTxO not found");
  const proxyValidator = utxo.scriptRef!;
  const proxyPolicyId = validatorToScriptHash(proxyValidator);
  const logicHash = Data.from(utxo.datum!, ProxyDatum).script_pointer;
  const v1 = buildLogicV1Script(proxyPolicyId);
  const v2 = buildLogicV2Script(proxyPolicyId);
  const isV1 = logicHash === validatorToScriptHash(v1);
  const current = isV1 ? v1 : v2;
  const next = isV1 ? v2 : v1;

  const redeemer = Data.to(new Constr(1, []));
  const withdrawRedeemer = isV1
    ? Data.to({ token_name: encodeHex("ProxyMintToken"), password: encodeHex("Hello, World!") }, WithdrawalRedeemerV1)
    : Data.to({ invalid_token_name: encodeHex("InvalidToken") }, WithdrawalRedeemerV2);

  const utxos = await lucid.utxosAtWithUnit(validatorToAddress(NETWORK, proxyValidator), tokenUnit);
  const stateUtxo = utxos[0];

  const newDatum = Data.to(
    { script_pointer: validatorToScriptHash(next), script_owner: ownerVkh },
    ProxyDatum,
  );

  let txb = lucid
    .newTx()
    .collectFrom([stateUtxo], redeemer)
    .pay.ToContract(
      validatorToAddress(NETWORK, proxyValidator),
      { kind: "inline", value: newDatum },
      { [tokenUnit]: 1n },
      proxyValidator,
    )
    .attach.SpendingValidator(proxyValidator)
    .attach.WithdrawalValidator(current)
    .withdraw(validatorToRewardAddress(NETWORK, current), 0n, withdrawRedeemer)
    .addSigner(ownerAddr);
  if (isV1) {
    txb = txb.register.Stake(validatorToRewardAddress(NETWORK, next));
  }
  const tx = await txb.complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`CHANGE_VERSION (${isV1 ? "v1→v2" : "v2→v1"}) ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== upgradable-proxy scenario: init → mint(v1) → change-version → mint(v2) ===");
  const seed = generateSeedPhrase();
  const lucid = await lucidFromSeed(seed);
  await fundFromIndex0(await lucid.wallet().address(), 200_000_000n);

  const { tokenUnit } = await initProxy(lucid);
  await new Promise((r) => setTimeout(r, 3000));
  await mintProxyToken(lucid, tokenUnit);
  await new Promise((r) => setTimeout(r, 3000));
  await changeVersion(lucid, tokenUnit);
  await new Promise((r) => setTimeout(r, 3000));
  await mintProxyToken(lucid, tokenUnit);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
