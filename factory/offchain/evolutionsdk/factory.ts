import {
  Lucid,
  Koios,
  applyParamsToScript,
  Constr,
  Data,
  fromText,
  toText,
  generateSeedPhrase,
  paymentCredentialOf,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
  type UTxO,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Factory — Evolution SDK port.
//
// 3 validators with chained parameters:
//   factory_marker (mint)   params: (owner_pkh, seed_outref)
//   factory        (spend)  params: (owner_pkh, factory_marker_policy_id)
//   product        (mint+spend) params: (owner_pkh, factory_marker_policy_id, product_id)
//
// Operations:
//   prepare         generate wallet.json
//   create-factory  one-shot: mint FACTORY_MARKER, lock at factory script with empty registry
//   create-product  spend factory UTxO, mint product NFT, append policy to registry,
//                   create product UTxO at product address with tag datum
//   get-factory     show factory state
//   get-products    list registered product policies
//   get-tag         read a product's tag
// ----------------------------------------------------------------------------

const KOIOS_URL = "https://preprod.koios.rest/api/v1";
const FACTORY_MARKER_NAME = "FACTORY_MARKER";

function selectWallet(lucid: LucidEvolution, fileName = "wallet.json") {
  const mnemonic = JSON.parse(Deno.readTextFileSync(fileName));
  lucid.selectWallet.fromSeed(
    Array.isArray(mnemonic) ? mnemonic.join(" ") : mnemonic,
  );
}

async function prepare() {
  const fileName = "wallet.json";
  try {
    await Deno.stat(fileName);
    console.log(`${fileName} already exists, skipping.`);
    return;
  } catch { /* not found */ }

  const mnemonic = generateSeedPhrase();
  await Deno.writeTextFile(fileName, JSON.stringify(mnemonic.split(" ")));
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  lucid.selectWallet.fromSeed(mnemonic);
  console.log(`Generated ${fileName}. Address: ${await lucid.wallet().address()}`);
}

function getValidator(prefix: string): string {
  const v = blueprint.validators.find((x) => x.title.startsWith(prefix));
  if (!v) throw new Error(`Validator not found: ${prefix}`);
  return v.compiledCode;
}

function buildOutputReference(txHash: string, idx: number): Constr<Data> {
  // Aiken OutputReference is `Constr 0 [tx_hash_bytes, idx]`.
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

function getProductScript(ownerPkh: string, markerPolicyId: string, productId: string): Script {
  return {
    type: "PlutusV3",
    script: applyParamsToScript(getValidator("product"), [
      ownerPkh,
      markerPolicyId,
      fromText(productId),
    ]),
  };
}

export async function createFactory() {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerAddr = await lucid.wallet().address();
  const ownerPkh = paymentCredentialOf(ownerAddr).hash;

  const utxos = await lucid.utxosAt(ownerAddr);
  if (utxos.length === 0) throw new Error("No wallet UTxOs");
  const seedUtxo = utxos[0];

  const markerScript = getFactoryMarkerScript(ownerPkh, seedUtxo);
  const markerPolicyId = validatorToScriptHash(markerScript);
  const factoryScript = getFactoryScript(ownerPkh, markerPolicyId);
  const factoryAddr = validatorToAddress("Preprod", factoryScript);

  const markerUnit = markerPolicyId + fromText(FACTORY_MARKER_NAME);
  // FactoryDatum = Constr 0 [ List<PolicyId> ] starting empty.
  const initialDatum = Data.to(new Constr(0, [[]]));

  const tx = await lucid
    .newTx()
    .collectFrom([seedUtxo])
    // Mint redeemer is unused by validator; supply unit.
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

  console.log("Factory created");
  console.log("Owner PKH:", ownerPkh);
  console.log("Factory address:", factoryAddr);
  console.log("Factory marker policy:", markerPolicyId);
  console.log("Tx:", txHash);
}

export async function createProduct(
  markerPolicyId: string,
  productId: string,
  tag: string,
) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerAddr = await lucid.wallet().address();
  const ownerPkh = paymentCredentialOf(ownerAddr).hash;

  const factoryScript = getFactoryScript(ownerPkh, markerPolicyId);
  const factoryAddr = validatorToAddress("Preprod", factoryScript);
  const productScript = getProductScript(ownerPkh, markerPolicyId, productId);
  const productAddr = validatorToAddress("Preprod", productScript);
  const productPolicyId = validatorToScriptHash(productScript);

  const factoryUtxos = await lucid.utxosAt(factoryAddr);
  const factoryUtxo = factoryUtxos[0];
  if (!factoryUtxo) throw new Error("Factory state UTxO not found");

  const markerUnit = markerPolicyId + fromText(FACTORY_MARKER_NAME);
  const productUnit = productPolicyId + fromText(productId);

  // Updated factory datum: append the new product policy to the registry.
  const existingDatum = Data.from(factoryUtxo.datum!) as Constr<Data>;
  const existingPolicies = (existingDatum.fields[0] as Data[]) ?? [];
  const newRegistry = [...existingPolicies, productPolicyId];
  const updatedFactoryDatum = Data.to(new Constr(0, [newRegistry]));

  // Spend redeemer for factory: Constr 0 [productPolicyId, productId].
  const spendRedeemer = Data.to(
    new Constr(0, [productPolicyId, fromText(productId)]),
  );

  // Product datum: Constr 0 [tag].
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

  console.log("Product created");
  console.log("Product address:", productAddr);
  console.log("Product policy:", productPolicyId);
  console.log("Tx:", txHash);
}

export async function getFactory(markerPolicyId: string) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerPkh = paymentCredentialOf(await lucid.wallet().address()).hash;

  const factoryScript = getFactoryScript(ownerPkh, markerPolicyId);
  const factoryAddr = validatorToAddress("Preprod", factoryScript);
  const factoryHash = validatorToScriptHash(factoryScript);

  const utxos = await lucid.utxosAt(factoryAddr);

  console.log("--- Factory status ---");
  console.log("Owner PKH:", ownerPkh);
  console.log("Factory marker policy:", markerPolicyId);
  console.log("Factory script hash:", factoryHash);
  console.log("Factory address:", factoryAddr);
  console.log("Factory created:", utxos.length > 0);
}

export async function getProducts(markerPolicyId: string) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerPkh = paymentCredentialOf(await lucid.wallet().address()).hash;
  const factoryScript = getFactoryScript(ownerPkh, markerPolicyId);
  const factoryAddr = validatorToAddress("Preprod", factoryScript);

  const utxos = await lucid.utxosAt(factoryAddr);
  const stateUtxo = utxos.find((u) => u.datum);
  if (!stateUtxo) throw new Error("Factory state UTxO not found");

  const decoded = Data.from(stateUtxo.datum!) as Constr<Data>;
  const policies = decoded.fields[0] as string[];
  console.log("Factory product policy IDs:", policies);

  // For each policy, query Koios for assets minted under it.
  const allProducts: Array<{ productId: string; policyId: string; fingerprint: string }> = [];
  for (const policyId of policies) {
    const url = `${KOIOS_URL}/policy_asset_list?_asset_policy=${policyId}`;
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Koios error: ${response.statusText}`);
    const assets = await response.json();
    for (const asset of assets) {
      allProducts.push({
        productId: toText(asset.asset_name),
        policyId,
        fingerprint: asset.fingerprint,
      });
    }
  }
  console.log("Products fetched:", allProducts);
  return allProducts;
}

export async function getTag(markerPolicyId: string, productId: string) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerPkh = paymentCredentialOf(await lucid.wallet().address()).hash;
  const productScript = getProductScript(ownerPkh, markerPolicyId, productId);
  const productAddr = validatorToAddress("Preprod", productScript);

  const utxos = await lucid.utxosAt(productAddr);
  const stateUtxo = utxos.find((u) => u.datum);
  if (!stateUtxo) throw new Error("Product UTxO not found");

  const decoded = Data.from(stateUtxo.datum!) as Constr<Data>;
  const tag = toText(decoded.fields[0] as string);
  console.log("--- Product details ---");
  console.log("Product ID:", productId);
  console.log("Product policy:", validatorToScriptHash(productScript));
  console.log("Product address:", productAddr);
  console.log("Tag:", tag);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  try {
    if (cmd === "prepare") {
      await prepare();
    } else if (cmd === "create-factory") {
      await createFactory();
    } else if (cmd === "create-product") {
      if (args.length !== 3) {
        throw new Error("Usage: create-product <marker_policy_id> <product_id> <tag>");
      }
      await createProduct(args[0], args[1], args[2]);
    } else if (cmd === "get-factory") {
      if (args.length !== 1) throw new Error("Usage: get-factory <marker_policy_id>");
      await getFactory(args[0]);
    } else if (cmd === "get-products") {
      if (args.length !== 1) throw new Error("Usage: get-products <marker_policy_id>");
      await getProducts(args[0]);
    } else if (cmd === "get-tag") {
      if (args.length !== 2) throw new Error("Usage: get-tag <marker_policy_id> <product_id>");
      await getTag(args[0], args[1]);
    } else {
      console.log(
        "Usage:\n" +
          "  prepare\n" +
          "  create-factory\n" +
          "  create-product <marker_policy_id> <product_id> <tag>\n" +
          "  get-factory <marker_policy_id>\n" +
          "  get-products <marker_policy_id>\n" +
          "  get-tag <marker_policy_id> <product_id>\n",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
