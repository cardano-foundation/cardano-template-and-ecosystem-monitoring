import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  deserializeDatum,
  hexToString,
  mConStr0,
  outputReference,
  resolvePaymentKeyHash,
  resolveScriptHash,
  scriptHash,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// Factory: 3 validators (factory_marker mint, factory spend, product mint+spend).
// Scenario: create-factory → create-product × 2 → read tag.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const FACTORY_MARKER_NAME = "FACTORY_MARKER";
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

async function fundFromFunder(targetAddr: string, lovelace: bigint) {
  const wallet = funderWallet();
  const myAddr = await wallet.getChangeAddress();
  const myUtxos = await provider().fetchAddressUTxOs(myAddr);
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(targetAddr, [{ unit: "lovelace", quantity: lovelace.toString() }])
    .changeAddress(myAddr)
    .selectUtxosFrom(myUtxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Funded ${targetAddr.slice(0, 20)}… with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxoAt(targetAddr, 1);
}

function getValidator(prefix: string): string {
  const v = blueprint.validators.find((x) => x.title.startsWith(prefix));
  if (!v) throw new Error(`Validator not found: ${prefix}`);
  return v.compiledCode;
}

function getScriptAddress(compiled: string) {
  const { address } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return address;
}

function buildFactoryMarker(ownerPkh: string, seedUtxo: UTxO) {
  const factoryMarkerScript = applyParamsToScript(
    getValidator("factory_marker."),
    [
      builtinByteString(ownerPkh),
      outputReference(seedUtxo.input.txHash, seedUtxo.input.outputIndex),
    ],
    "JSON",
  );
  return { script: factoryMarkerScript, policyId: resolveScriptHash(factoryMarkerScript, "V3") };
}
function buildFactoryScript(ownerPkh: string, markerPolicyId: string) {
  const factoryScript = applyParamsToScript(
    getValidator("factory."),
    [builtinByteString(ownerPkh), scriptHash(markerPolicyId)],
    "JSON",
  );
  return {
    script: factoryScript,
    scriptHash: resolveScriptHash(factoryScript, "V3"),
    address: getScriptAddress(factoryScript),
  };
}
function buildProductScript(ownerPkh: string, markerPolicyId: string, productId: string) {
  const productScript = applyParamsToScript(
    getValidator("product"),
    [
      builtinByteString(ownerPkh),
      scriptHash(markerPolicyId),
      builtinByteString(stringToHex(productId)),
    ],
    "JSON",
  );
  return {
    script: productScript,
    policyId: resolveScriptHash(productScript, "V3"),
    address: getScriptAddress(productScript),
  };
}

async function createFactory(wallet: MeshWallet): Promise<string> {
  const ownerAddr = await wallet.getChangeAddress();
  const ownerPkh = resolvePaymentKeyHash(ownerAddr);
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);
  if (utxos.length === 0) throw new Error("No wallet UTxOs");
  const seedUtxo = utxos[0];

  const { script: markerScript, policyId: markerPolicyId } = buildFactoryMarker(ownerPkh, seedUtxo);
  const { address: factoryAddr } = buildFactoryScript(ownerPkh, markerPolicyId);
  const markerUnit = markerPolicyId + stringToHex(FACTORY_MARKER_NAME);
  const collateral: UTxO[] = await wallet.getCollateral();

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txIn(seedUtxo.input.txHash, seedUtxo.input.outputIndex, seedUtxo.output.amount, seedUtxo.output.address)
    .mintPlutusScriptV3()
    .mint("1", markerPolicyId, stringToHex(FACTORY_MARKER_NAME))
    // Inline minting script (vs. mintTxInReference): one-shot bootstrap; a reference UTxO would
    // mean an extra setup tx just to publish a script we use exactly once.
    .mintingScript(markerScript)
    .mintRedeemerValue(mConStr0([]))
    .txOut(factoryAddr, [{ unit: markerUnit, quantity: "1" }])
    .txOutInlineDatumValue(mConStr0([[]]))
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerPkh)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`CREATE_FACTORY ok. policy=${markerPolicyId.slice(0, 16)}… tx=${txHash}`);
  return markerPolicyId;
}

async function createProduct(
  wallet: MeshWallet,
  markerPolicyId: string,
  productId: string,
  tag: string,
) {
  const ownerAddr = await wallet.getChangeAddress();
  const ownerPkh = resolvePaymentKeyHash(ownerAddr);
  const factory = buildFactoryScript(ownerPkh, markerPolicyId);
  const product = buildProductScript(ownerPkh, markerPolicyId, productId);
  const factoryUtxos = await provider().fetchAddressUTxOs(factory.address);
  const factoryUtxo = factoryUtxos[0];
  if (!factoryUtxo || !factoryUtxo.output.plutusData) throw new Error("Factory UTxO not found");

  const markerUnit = markerPolicyId + stringToHex(FACTORY_MARKER_NAME);
  const productUnit = product.policyId + stringToHex(productId);

  const existing = deserializeDatum(factoryUtxo.output.plutusData) as {
    fields: Array<{ list?: Array<{ bytes: string }> }>;
  };
  const existingPolicies = (existing.fields[0].list ?? []).map((b) => b.bytes);
  const newRegistry = [...existingPolicies, product.policyId];
  const updatedDatum = mConStr0([newRegistry]);

  const spendRedeemer = mConStr0([product.policyId, stringToHex(productId)]);
  const productDatum = mConStr0([stringToHex(tag)]);
  const ownUtxos = await provider().fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  // Multiple Plutus scripts in one tx — default per-redeemer budget × N exceeds the tx limit,
  // so set conservative explicit exUnits per call.
  const exUnits = { mem: 5_000_000, steps: 2_000_000_000 };
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(factoryUtxo.input.txHash, factoryUtxo.input.outputIndex, factoryUtxo.output.amount, factory.address)
    .txInScript(factory.script)
    .txInRedeemerValue(spendRedeemer, "Mesh", exUnits)
    .txInInlineDatumPresent()
    .mintPlutusScriptV3()
    .mint("1", product.policyId, stringToHex(productId))
    .mintingScript(product.script)
    .mintRedeemerValue(mConStr0([]), "Mesh", exUnits)
    .txOut(factory.address, [{ unit: markerUnit, quantity: "1" }])
    .txOutInlineDatumValue(updatedDatum)
    .txOut(product.address, [{ unit: productUnit, quantity: "1" }])
    .txOutInlineDatumValue(productDatum)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerPkh)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`CREATE_PRODUCT ok. id=${productId} tx=${txHash}`);
}

async function getProductTag(
  wallet: MeshWallet,
  markerPolicyId: string,
  productId: string,
) {
  const ownerAddr = await wallet.getChangeAddress();
  const ownerPkh = resolvePaymentKeyHash(ownerAddr);
  const product = buildProductScript(ownerPkh, markerPolicyId, productId);
  const utxos = await provider().fetchAddressUTxOs(product.address);
  const stateUtxo = utxos.find((u) => u.output.plutusData);
  if (!stateUtxo) throw new Error("Product UTxO not found");
  const d = deserializeDatum(stateUtxo.output.plutusData!) as {
    fields: Array<{ bytes?: string }>;
  };
  const tag = hexToString(d.fields[0].bytes ?? "");
  console.log(`Product ${productId} tag: ${tag}`);
  return tag;
}

async function runScenario() {
  console.log("=== factory scenario: create-factory → create-product × 2 → read tag ===");
  const wallet = makeWallet(MeshWallet.brew(false) as string[]);
  await fundFromFunder(await wallet.getChangeAddress(), 200_000_000n);

  const markerPolicyId = await createFactory(wallet);
  await new Promise((r) => setTimeout(r, 2000));
  await createProduct(wallet, markerPolicyId, "widget-001", "blue");
  await new Promise((r) => setTimeout(r, 2000));
  await createProduct(wallet, markerPolicyId, "widget-002", "red");
  await new Promise((r) => setTimeout(r, 2000));
  await getProductTag(wallet, markerPolicyId, "widget-001");
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
