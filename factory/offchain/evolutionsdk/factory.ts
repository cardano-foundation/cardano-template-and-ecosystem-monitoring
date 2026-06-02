import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  applyParamsToScript,
  fromText,
  generateSeedPhrase,
  paymentCredentialOf,
  toText,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
  type UTxO,
} from "@evolution-sdk/lucid";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// ----------------------------------------------------------------------------
// Factory + Product pattern. Three PlutusV3 validators wired together:
// factory_marker (one-shot mint parameterised by a seed OutputReference),
// factory (spend that registers new product policies), and product (mint
// gated by the factory marker). createFactory consumes the seed UTxO so
// the marker can only ever mint once.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const FACTORY_MARKER_NAME = "FACTORY_MARKER";

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

function getValidator(prefix: string): string {
  const v = blueprint.validators.find((x) => x.title.startsWith(prefix));
  if (!v) throw new Error(`Validator not found: ${prefix}`);
  return v.compiledCode;
}

function buildOutputReference(txHash: string, idx: number): Constr<Data> {
  return new Constr(0, [txHash, BigInt(idx)]);
}

function getFactoryMarkerScript(ownerPkh: string, seedUtxo: UTxO): Script {
  return {
    type: "PlutusV3",
    script: applyParamsToScript(getValidator("factory_marker."), [
      ownerPkh,
      buildOutputReference(seedUtxo.txHash, seedUtxo.outputIndex),
    ]),
  };
}
function getFactoryScript(ownerPkh: string, markerPolicyId: string): Script {
  return {
    type: "PlutusV3",
    script: applyParamsToScript(getValidator("factory."), [ownerPkh, markerPolicyId]),
  };
}
function getProductScript(
  ownerPkh: string,
  markerPolicyId: string,
  productId: string,
): Script {
  return {
    type: "PlutusV3",
    script: applyParamsToScript(getValidator("product"), [
      ownerPkh,
      markerPolicyId,
      fromText(productId),
    ]),
  };
}

async function createFactory(lucid: LucidEvolution): Promise<string> {
  const ownerAddr = await lucid.wallet().address();
  const ownerPkh = paymentCredentialOf(ownerAddr).hash;
  const utxos = await lucid.utxosAt(ownerAddr);
  if (utxos.length === 0) throw new Error("No wallet UTxOs");
  const seedUtxo = utxos[0];

  const markerScript = getFactoryMarkerScript(ownerPkh, seedUtxo);
  const markerPolicyId = validatorToScriptHash(markerScript);
  const factoryScript = getFactoryScript(ownerPkh, markerPolicyId);
  const factoryAddr = validatorToAddress(NETWORK, factoryScript);
  const markerUnit = markerPolicyId + fromText(FACTORY_MARKER_NAME);
  const initialDatum = Data.to(new Constr(0, [[]]));

  const tx = await lucid
    .newTx()
    .collectFrom([seedUtxo])
    .mintAssets({ [markerUnit]: 1n }, Data.void())
    .attach.MintingPolicy(markerScript)
    .pay.ToContract(
      factoryAddr,
      { kind: "inline", value: initialDatum },
      { [markerUnit]: 1n },
    )
    .addSigner(ownerAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`CREATE_FACTORY ok. policy=${markerPolicyId.slice(0, 16)}… tx=${txHash}`);
  return markerPolicyId;
}

async function createProduct(
  lucid: LucidEvolution,
  markerPolicyId: string,
  productId: string,
  tag: string,
) {
  const ownerAddr = await lucid.wallet().address();
  const ownerPkh = paymentCredentialOf(ownerAddr).hash;
  const factoryScript = getFactoryScript(ownerPkh, markerPolicyId);
  const factoryAddr = validatorToAddress(NETWORK, factoryScript);
  const productScript = getProductScript(ownerPkh, markerPolicyId, productId);
  const productAddr = validatorToAddress(NETWORK, productScript);
  const productPolicyId = validatorToScriptHash(productScript);

  const factoryUtxos = await lucid.utxosAt(factoryAddr);
  const factoryUtxo = factoryUtxos[0];
  if (!factoryUtxo) throw new Error("Factory state UTxO not found");

  const markerUnit = markerPolicyId + fromText(FACTORY_MARKER_NAME);
  const productUnit = productPolicyId + fromText(productId);
  const existingDatum = Data.from(factoryUtxo.datum!) as Constr<Data>;
  const existingPolicies = (existingDatum.fields[0] as Data[]) ?? [];
  const updatedFactoryDatum = Data.to(
    new Constr(0, [[...existingPolicies, productPolicyId]]),
  );
  const spendRedeemer = Data.to(
    new Constr(0, [productPolicyId, fromText(productId)]),
  );
  const productDatum = Data.to(new Constr(0, [fromText(tag)]));

  const tx = await lucid
    .newTx()
    .collectFrom([factoryUtxo], spendRedeemer)
    .attach.SpendingValidator(factoryScript)
    .mintAssets({ [productUnit]: 1n }, Data.void())
    .attach.MintingPolicy(productScript)
    .pay.ToContract(
      factoryAddr,
      { kind: "inline", value: updatedFactoryDatum },
      { [markerUnit]: 1n },
    )
    .pay.ToContract(
      productAddr,
      { kind: "inline", value: productDatum },
      { [productUnit]: 1n },
    )
    .addSigner(ownerAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`CREATE_PRODUCT ok. id=${productId} tx=${txHash}`);
}

async function getProductTag(
  lucid: LucidEvolution,
  markerPolicyId: string,
  productId: string,
) {
  const ownerPkh = paymentCredentialOf(await lucid.wallet().address()).hash;
  const productScript = getProductScript(ownerPkh, markerPolicyId, productId);
  const productAddr = validatorToAddress(NETWORK, productScript);
  const utxos = await lucid.utxosAt(productAddr);
  const stateUtxo = utxos.find((u) => u.datum);
  if (!stateUtxo) throw new Error("Product UTxO not found");
  const decoded = Data.from(stateUtxo.datum!) as Constr<Data>;
  const tag = toText(decoded.fields[0] as string);
  console.log(`Product ${productId} tag: ${tag}`);
  return tag;
}

async function runScenario() {
  console.log("=== factory scenario: create-factory → create-product × 2 → read tag ===");
  // Fresh seed so the parameterised marker policy is unique to this run.
  const seed = generateSeedPhrase();
  const lucid = await lucidFromSeed(seed);
  const ownerAddr = await lucid.wallet().address();
  await fundFromIndex0(ownerAddr, 200_000_000n);

  const markerPolicyId = await createFactory(lucid);
  await new Promise((r) => setTimeout(r, 2000));
  await createProduct(lucid, markerPolicyId, "widget-001", "blue");
  await new Promise((r) => setTimeout(r, 2000));
  await createProduct(lucid, markerPolicyId, "widget-002", "red");
  await new Promise((r) => setTimeout(r, 2000));
  await getProductTag(lucid, markerPolicyId, "widget-001");
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
