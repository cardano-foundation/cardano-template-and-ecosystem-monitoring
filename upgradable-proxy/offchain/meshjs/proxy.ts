import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  deserializeDatum,
  mConStr0,
  mConStr1,
  outputReference,
  resolvePaymentKeyHash,
  resolveScriptHash,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import {
  applyParamsToScript,
  scriptHashToRewardAddress,
} from "@meshsdk/core-csl";
import { sha3_256 } from "@noble/hashes/sha3";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// Upgradable proxy: proxy script publishes itself as a reference UTxO and delegates logic
// via withdraw-zero to versioned logic scripts. Scenario: init → mint(v1) → swap → mint(v2).
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const PROXY_MINT_TOKEN = "ProxyMintToken";
const FUNDER_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

function provider(): BlockfrostProvider {
  return new BlockfrostProvider(YACI_URL);
}
function makeWallet(words: string[]): MeshWallet {
  const p = provider();
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: p,
    submitter: p,
    key: { type: "mnemonic", words },
  });
}
function funderWallet(): MeshWallet {
  return makeWallet(FUNDER_MNEMONIC.split(/\s+/));
}

async function waitForUtxoAt(addr: string, minCount = 1, timeoutSec = 60) {
  const p = provider();
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await p.fetchAddressUTxOs(addr);
      if (u.length >= minCount) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${addr}`);
}

async function fundFromFunder(targetAddr: string, lovelace: bigint, splits = 1) {
  const wallet = funderWallet();
  const myAddr = await wallet.getChangeAddress();
  const myUtxos = await provider().fetchAddressUTxOs(myAddr);
  const each = lovelace / BigInt(splits);
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let b = tx as unknown as MeshTxBuilder;
  for (let i = 0; i < splits; i++) {
    b = b.txOut(targetAddr, [{ unit: "lovelace", quantity: each.toString() }]);
  }
  await b.changeAddress(myAddr).selectUtxosFrom(myUtxos).complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Funded ${targetAddr.slice(0, 20)}… with ${lovelace} lovelace (${splits} UTxOs). tx=${txHash}`);
  await waitForUtxoAt(targetAddr, splits);
}

function getValidator(prefix: string): string {
  const v = blueprint.validators.find((x) => x.title.startsWith(prefix));
  if (!v) throw new Error(`Validator not found: ${prefix}`);
  return v.compiledCode;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stateTokenName(txHash: string, outputIndex: number): string {
  const txHashBytes = new Uint8Array(txHash.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const idxBytes = new TextEncoder().encode(outputIndex.toString());
  const buf = new Uint8Array(txHashBytes.length + idxBytes.length);
  buf.set(txHashBytes, 0);
  buf.set(idxBytes, txHashBytes.length);
  return bytesToHex(sha3_256(buf));
}

function buildProxyScript(seedUtxo: UTxO) {
  const outRef = outputReference(seedUtxo.input.txHash, seedUtxo.input.outputIndex);
  const script = applyParamsToScript(getValidator("proxy."), [outRef], "JSON");
  const policyId = resolveScriptHash(script, "V3");
  const { address } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, policyId, address };
}

function buildLogicScript(version: 1 | 2, proxyPolicyId: string) {
  const script = applyParamsToScript(
    getValidator(`script_logic_v_${version}.`),
    [builtinByteString(proxyPolicyId)],
    "JSON",
  );
  const scriptHash = resolveScriptHash(script, "V3");
  const rewardAddress = scriptHashToRewardAddress(scriptHash, NETWORK_ID);
  return { script, scriptHash, rewardAddress };
}

interface ProxyDatum { scriptPointer: string; scriptOwner: string }
function decodeProxyDatum(datumHex: string): ProxyDatum {
  const d = deserializeDatum(datumHex) as { fields: Array<{ bytes: string }> };
  return { scriptPointer: d.fields[0].bytes, scriptOwner: d.fields[1].bytes };
}
function encodeProxyDatum(d: ProxyDatum): unknown {
  return mConStr0([d.scriptPointer, d.scriptOwner]);
}

async function pickCollateral(wallet: MeshWallet, utxos: UTxO[]): Promise<UTxO> {
  // yaci-devkit rejects multi-asset collateral; force a pure-ADA UTxO.
  const fromWallet = (await wallet.getCollateral()).filter(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace",
  );
  if (fromWallet.length > 0) return fromWallet[0];
  const pureAda = utxos.find(
    (u) =>
      u.output.amount.length === 1 &&
      u.output.amount[0].unit === "lovelace" &&
      BigInt(u.output.amount[0].quantity) >= 5_000_000n,
  );
  if (!pureAda) throw new Error("No pure-ADA collateral UTxO available");
  return pureAda;
}

async function findProxyUtxo(tokenUnit: string, proxyAddress: string): Promise<UTxO> {
  const p = provider();
  for (let i = 0; i < 60; i++) {
    try {
      const utxos = await p.fetchAddressUTxOs(proxyAddress);
      const u = utxos.find((x) =>
        x.output.amount.some((a) => a.unit === tokenUnit && a.quantity === "1"),
      );
      if (u) return u;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`State UTxO with token ${tokenUnit} not found`);
}

interface ProxyContext {
  tokenUnit: string;
  proxyAddress: string;
  proxyPolicyId: string;
  proxyScript: string;
  seedTxHash: string;
  seedOutputIndex: number;
}

async function init(wallet: MeshWallet): Promise<ProxyContext> {
  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);
  const seedUtxo = utxos.find((u) => {
    const lov = u.output.amount.find((a) => a.unit === "lovelace");
    return lov && BigInt(lov.quantity) > 10_000_000n;
  });
  if (!seedUtxo) throw new Error("No suitable seed UTxO");

  const proxy = buildProxyScript(seedUtxo);
  const v1 = buildLogicScript(1, proxy.policyId);
  const tokenNameHex = stateTokenName(seedUtxo.input.txHash, seedUtxo.input.outputIndex);
  const tokenUnit = proxy.policyId + tokenNameHex;
  const datum: ProxyDatum = { scriptPointer: v1.scriptHash, scriptOwner: ownerVkh };
  const col = await pickCollateral(wallet, utxos);
  const collateral = [col];

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txIn(seedUtxo.input.txHash, seedUtxo.input.outputIndex, seedUtxo.output.amount, seedUtxo.output.address)
    .mintPlutusScriptV3()
    .mint("1", proxy.policyId, tokenNameHex)
    // Inline minting script here (first time the proxy is used) — subsequent calls below use
    // mintTxInReference against the reference UTxO this tx publishes via txOutReferenceScript.
    .mintingScript(proxy.script)
    // Multiple Plutus scripts in one tx — default per-redeemer budget × N exceeds the tx limit,
    // so set conservative explicit exUnits per call.
    .mintRedeemerValue(mConStr1([]), "Mesh", { mem: 5_000_000, steps: 2_000_000_000 })
    .registerStakeCertificate(v1.rewardAddress)
    .txOut(proxy.address, [{ unit: tokenUnit, quantity: "1" }])
    .txOutInlineDatumValue(encodeProxyDatum(datum))
    .txOutReferenceScript(proxy.script, "V3")
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`INIT ok. tx=${txHash}`);
  return {
    tokenUnit,
    proxyAddress: proxy.address,
    proxyPolicyId: proxy.policyId,
    proxyScript: proxy.script,
    seedTxHash: seedUtxo.input.txHash,
    seedOutputIndex: seedUtxo.input.outputIndex,
  };
}

async function mintToken(wallet: MeshWallet, ctx: ProxyContext) {
  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const proxyUtxo = await findProxyUtxo(ctx.tokenUnit, ctx.proxyAddress);
  if (!proxyUtxo.output.plutusData) throw new Error("No datum");
  const datum = decodeProxyDatum(proxyUtxo.output.plutusData);
  const v1 = buildLogicScript(1, ctx.proxyPolicyId);
  const v2 = buildLogicScript(2, ctx.proxyPolicyId);
  const isV1 = datum.scriptPointer === v1.scriptHash;
  const logic = isV1 ? v1 : v2;

  const proxyMintRedeemer = mConStr0([]);
  const withdrawRedeemer = isV1
    ? mConStr0([stringToHex(PROXY_MINT_TOKEN), stringToHex("NoPassword")])
    : mConStr0([stringToHex("InvalidToken")]);

  const productUnit = ctx.proxyPolicyId + stringToHex(PROXY_MINT_TOKEN);
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);
  const col = await pickCollateral(wallet, utxos);
  const collateral = [col];

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .readOnlyTxInReference(proxyUtxo.input.txHash, proxyUtxo.input.outputIndex)
    .mintPlutusScriptV3()
    .mint("1", ctx.proxyPolicyId, stringToHex(PROXY_MINT_TOKEN))
    // The proxy script is attached to this reference UTxO; reusing it via mintTxInReference
    // (instead of inline mintingScript) avoids "ExtraneousScriptWitnesses" from the ledger.
    .mintTxInReference(proxyUtxo.input.txHash, proxyUtxo.input.outputIndex)
    .mintRedeemerValue(proxyMintRedeemer, "Mesh", { mem: 5_000_000, steps: 2_000_000_000 })
    .withdrawalPlutusScriptV3()
    .withdrawal(logic.rewardAddress, "0")
    .withdrawalScript(logic.script)
    .withdrawalRedeemerValue(withdrawRedeemer, "Mesh", { mem: 5_000_000, steps: 2_000_000_000 })
    .txOut(ownerAddr, [{ unit: productUnit, quantity: "1" }])
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`MINT (v${isV1 ? 1 : 2}) ok. tx=${txHash}`);
}

async function changeVersion(wallet: MeshWallet, ctx: ProxyContext) {
  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const proxyUtxo = await findProxyUtxo(ctx.tokenUnit, ctx.proxyAddress);
  if (!proxyUtxo.output.plutusData) throw new Error("No datum");
  const datum = decodeProxyDatum(proxyUtxo.output.plutusData);
  const v1 = buildLogicScript(1, ctx.proxyPolicyId);
  const v2 = buildLogicScript(2, ctx.proxyPolicyId);
  const currentIsV1 = datum.scriptPointer === v1.scriptHash;
  const current = currentIsV1 ? v1 : v2;
  const next = currentIsV1 ? v2 : v1;

  const newDatum: ProxyDatum = { scriptPointer: next.scriptHash, scriptOwner: ownerVkh };
  const spendRedeemer = mConStr1([]);
  const withdrawRedeemer = currentIsV1
    ? mConStr0([stringToHex(PROXY_MINT_TOKEN), stringToHex("Hello, World!")])
    : mConStr0([stringToHex("InvalidToken")]);

  const utxos = await provider().fetchAddressUTxOs(ownerAddr);
  const col = await pickCollateral(wallet, utxos);
  const collateral = [col];

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let chain = tx
    .spendingPlutusScriptV3()
    .txIn(proxyUtxo.input.txHash, proxyUtxo.input.outputIndex, proxyUtxo.output.amount, proxyUtxo.output.address)
    // spendingTxInReference (vs. inline txInScript) reuses the script attached to the proxy
    // UTxO itself — required since the same UTxO carries the reference script.
    .spendingTxInReference(proxyUtxo.input.txHash, proxyUtxo.input.outputIndex)
    .txInRedeemerValue(spendRedeemer, "Mesh", { mem: 5_000_000, steps: 2_000_000_000 })
    .txInInlineDatumPresent()
    .withdrawalPlutusScriptV3()
    .withdrawal(current.rewardAddress, "0")
    .withdrawalScript(current.script)
    .withdrawalRedeemerValue(withdrawRedeemer, "Mesh", { mem: 5_000_000, steps: 2_000_000_000 })
    .txOut(proxyUtxo.output.address, proxyUtxo.output.amount)
    .txOutInlineDatumValue(encodeProxyDatum(newDatum))
    .txOutReferenceScript(ctx.proxyScript, "V3");
  if (currentIsV1) chain = chain.registerStakeCertificate(next.rewardAddress);
  await chain
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`CHANGE_VERSION (${currentIsV1 ? "v1→v2" : "v2→v1"}) ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== upgradable-proxy scenario: init → mint(v1) → change-version → mint(v2) ===");
  const wallet = makeWallet(MeshWallet.brew(false) as string[]);
  // Split into 5 pure-ADA UTxOs: yaci-devkit rejects multi-asset collateral, so every Plutus
  // tx needs a clean ada-only input available as collateral without consuming the same UTxO.
  await fundFromFunder(await wallet.getChangeAddress(), 250_000_000n, 5);

  const ctx = await init(wallet);
  await new Promise((r) => setTimeout(r, 3000));
  await mintToken(wallet, ctx);
  await new Promise((r) => setTimeout(r, 3000));
  await changeVersion(wallet, ctx);
  await new Promise((r) => setTimeout(r, 3000));
  await mintToken(wallet, ctx);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
