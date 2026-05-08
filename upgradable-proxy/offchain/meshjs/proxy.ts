import {
  KoiosProvider,
  MeshTxBuilder,
  MeshWallet,
  deserializeDatum,
  mConStr0,
  mConStr1,
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
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Upgradable proxy — Mesh.js port of the evosdk reference.
//
// Validators:
//   proxy           (mint+spend)   param: utxo OutputReference
//   script_logic_v_1 (withdraw)    param: proxy_policy_id
//   script_logic_v_2 (withdraw)    param: proxy_policy_id
//
// Proxy datum: { script_pointer, script_owner }
//
// Operations:
//   prepare        generate wallet.txt
//   init           one-shot: spend a seed UTxO, mint state token, register
//                  v1 stake address, lock proxy state with v1 pointer
//   mint           use the proxy: read state UTxO, mint product token via
//                  v1 withdrawal validator
//   change-version flip pointer between v1 and v2 (and register v2 stake
//                  the first time you upgrade).
// ----------------------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;
const PROXY_MINT_TOKEN = "ProxyMintToken";

function loadWallet(walletFile = "wallet.txt"): MeshWallet {
  const mnemonic = Deno.readTextFileSync(walletFile).trim();
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: new KoiosProvider(NETWORK),
    submitter: new KoiosProvider(NETWORK),
    key: { type: "mnemonic", words: mnemonic.split(" ") },
  });
}

function getValidator(prefix: string): string {
  const v = blueprint.validators.find((x) => x.title.startsWith(prefix));
  if (!v) throw new Error(`Validator not found: ${prefix}`);
  return v.compiledCode;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// State token name = sha3_256(tx_hash_bytes || ascii(output_index))
function stateTokenName(txHash: string, outputIndex: number): string {
  const txHashBytes = new Uint8Array(
    txHash.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
  );
  const idxBytes = new TextEncoder().encode(outputIndex.toString());
  const buf = new Uint8Array(txHashBytes.length + idxBytes.length);
  buf.set(txHashBytes, 0);
  buf.set(idxBytes, txHashBytes.length);
  return bytesToHex(sha3_256(buf));
}

function buildProxyScript(seedUtxo: UTxO): { script: string; policyId: string; address: string } {
  // Aiken OutputReference: Constr 0 [tx_hash, idx]
  const outRefData = mConStr0([seedUtxo.input.txHash, seedUtxo.input.outputIndex]);
  const script = applyParamsToScript(getValidator("proxy."), [outRefData], "JSON");
  const policyId = resolveScriptHash(script, "V3");
  const { address } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, policyId, address };
}

function buildLogicScript(version: 1 | 2, proxyPolicyId: string): {
  script: string;
  scriptHash: string;
  rewardAddress: string;
} {
  const script = applyParamsToScript(
    getValidator(`script_logic_v_${version}.`),
    [proxyPolicyId],
    "JSON",
  );
  const scriptHash = resolveScriptHash(script, "V3");
  const rewardAddress = scriptHashToRewardAddress(scriptHash, NETWORK_ID);
  return { script, scriptHash, rewardAddress };
}

interface ProxyDatum {
  scriptPointer: string;
  scriptOwner: string;
}

function decodeProxyDatum(datumHex: string): ProxyDatum {
  const decoded = deserializeDatum(datumHex) as {
    fields: Array<{ bytes: string }>;
  };
  return {
    scriptPointer: decoded.fields[0].bytes,
    scriptOwner: decoded.fields[1].bytes,
  };
}

function encodeProxyDatum(d: ProxyDatum): unknown {
  return mConStr0([d.scriptPointer, d.scriptOwner]);
}

export async function init() {
  const wallet = loadWallet();
  const provider = new KoiosProvider(NETWORK);
  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);

  const utxos = await provider.fetchAddressUTxOs(ownerAddr);
  const seedUtxo = utxos.find((u) => {
    const lovelace = u.output.amount.find((a) => a.unit === "lovelace");
    return lovelace && BigInt(lovelace.quantity) > 2_000_000n;
  });
  if (!seedUtxo) throw new Error("No suitable seed UTxO");

  const proxy = buildProxyScript(seedUtxo);
  const v1 = buildLogicScript(1, proxy.policyId);

  const tokenNameHex = stateTokenName(seedUtxo.input.txHash, seedUtxo.input.outputIndex);
  const tokenUnit = proxy.policyId + tokenNameHex;
  const datum: ProxyDatum = { scriptPointer: v1.scriptHash, scriptOwner: ownerVkh };

  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .txIn(
      seedUtxo.input.txHash,
      seedUtxo.input.outputIndex,
      seedUtxo.output.amount,
      seedUtxo.output.address,
    )
    // Mint state token. Proxy mint redeemer (Init): Constr 1 [].
    .mintPlutusScriptV3()
    .mint("1", proxy.policyId, tokenNameHex)
    .mintingScript(proxy.script)
    .mintRedeemerValue(mConStr1([]), "JSON")
    // Register v1 stake address (so future withdrawals can succeed).
    .registerStakeCertificate(v1.rewardAddress)
    // Lock state token at proxy script with the script attached as reference.
    .txOut(proxy.address, [{ unit: tokenUnit, quantity: "1" }])
    .txOutInlineDatumValue(encodeProxyDatum(datum), "JSON")
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
  console.log("Proxy initialised");
  console.log("Proxy address:", proxy.address);
  console.log("Proxy policy:", proxy.policyId);
  console.log("State token:  ", tokenUnit);
  console.log("Tx:", txHash);
}

async function findProxyUtxo(provider: KoiosProvider, tokenUnit: string): Promise<UTxO> {
  const policyId = tokenUnit.slice(0, 56);
  // Best-effort: scan a small set of UTxOs at the proxy address. Without a
  // first-class utxoByUnit endpoint, callers can pass a tokenUnit they minted.
  // We try a brute-force fetch over policy_asset addresses via Koios.
  const url =
    `https://preprod.koios.rest/api/v1/asset_utxos?_asset_list=` +
    `[["${policyId}","${tokenUnit.slice(56)}"]]`;
  const resp = await fetch(url, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error("Koios asset_utxos failed");
  const items = await resp.json();
  if (items.length === 0) throw new Error("No UTxO holds the state token");
  const txHash = items[0].tx_hash;
  const outputs = await provider.fetchUTxOs(txHash);
  const utxo = outputs.find((u) =>
    u.output.amount.some((a) => a.unit === tokenUnit),
  );
  if (!utxo) throw new Error("State UTxO not found in tx outputs");
  return utxo;
}

export async function mintToken(tokenUnit: string) {
  const wallet = loadWallet();
  const provider = new KoiosProvider(NETWORK);
  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);

  const proxyUtxo = await findProxyUtxo(provider, tokenUnit);
  if (!proxyUtxo.output.plutusData) throw new Error("Proxy UTxO has no datum");
  if (!proxyUtxo.output.scriptRef) throw new Error("Proxy UTxO has no reference script");

  const datum = decodeProxyDatum(proxyUtxo.output.plutusData);
  const proxyPolicyId = tokenUnit.slice(0, 56);
  const v1 = buildLogicScript(1, proxyPolicyId);
  const v2 = buildLogicScript(2, proxyPolicyId);
  const isV1 = datum.scriptPointer === v1.scriptHash;
  const logic = isV1 ? v1 : v2;

  // Mint redeemer for proxy is unused by mint path here; supply unit-style.
  // Using Constr 0 [] = "Mint via proxy" branch.
  const proxyMintRedeemer = mConStr0([]);

  // Withdrawal redeemer per logic version.
  const withdrawRedeemer = isV1
    ? mConStr0([stringToHex(PROXY_MINT_TOKEN), stringToHex("NoPassword")])
    : mConStr0([stringToHex("InvalidToken")]);

  const productUnit = proxyPolicyId + stringToHex(PROXY_MINT_TOKEN);

  const utxos = await provider.fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    // Reference the proxy UTxO (don't spend it).
    .readOnlyTxInReference(proxyUtxo.input.txHash, proxyUtxo.input.outputIndex)
    .mintPlutusScriptV3()
    .mint("1", proxyPolicyId, stringToHex(PROXY_MINT_TOKEN))
    .mintingScript(proxyUtxo.output.scriptRef!)
    .mintRedeemerValue(proxyMintRedeemer, "JSON")
    .withdrawalPlutusScriptV3()
    .withdrawal(logic.rewardAddress, "0")
    .withdrawalScript(logic.script)
    .withdrawalRedeemerValue(withdrawRedeemer, "JSON")
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
  console.log(`Minted ${PROXY_MINT_TOKEN} via logic v${isV1 ? 1 : 2}. Tx:`, txHash);
}

export async function changeVersion(tokenUnit: string) {
  const wallet = loadWallet();
  const provider = new KoiosProvider(NETWORK);
  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);

  const proxyUtxo = await findProxyUtxo(provider, tokenUnit);
  if (!proxyUtxo.output.plutusData) throw new Error("Proxy UTxO has no datum");
  if (!proxyUtxo.output.scriptRef) throw new Error("Proxy UTxO has no reference script");

  const proxyPolicyId = tokenUnit.slice(0, 56);
  const datum = decodeProxyDatum(proxyUtxo.output.plutusData);
  const v1 = buildLogicScript(1, proxyPolicyId);
  const v2 = buildLogicScript(2, proxyPolicyId);
  const currentIsV1 = datum.scriptPointer === v1.scriptHash;
  const current = currentIsV1 ? v1 : v2;
  const next = currentIsV1 ? v2 : v1;

  const newDatum: ProxyDatum = {
    scriptPointer: next.scriptHash,
    scriptOwner: ownerVkh,
  };

  // Spending redeemer for the proxy validator: Constr 1 [] (Update).
  const spendRedeemer = mConStr1([]);
  const withdrawRedeemer = currentIsV1
    ? mConStr0([stringToHex(PROXY_MINT_TOKEN), stringToHex("Hello, World!")])
    : mConStr0([stringToHex("InvalidToken")]);

  const utxos = await provider.fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  let chain = tx
    .spendingPlutusScriptV3()
    .txIn(
      proxyUtxo.input.txHash,
      proxyUtxo.input.outputIndex,
      proxyUtxo.output.amount,
      proxyUtxo.output.address,
    )
    .txInScript(proxyUtxo.output.scriptRef!)
    .txInRedeemerValue(spendRedeemer, "JSON")
    .txInInlineDatumPresent()
    .withdrawalPlutusScriptV3()
    .withdrawal(current.rewardAddress, "0")
    .withdrawalScript(current.script)
    .withdrawalRedeemerValue(withdrawRedeemer, "JSON")
    .txOut(proxyUtxo.output.address, proxyUtxo.output.amount)
    .txOutInlineDatumValue(encodeProxyDatum(newDatum), "JSON")
    .txOutReferenceScript(proxyUtxo.output.scriptRef!, "V3");

  // First-time upgrade to a version registers its stake.
  if (currentIsV1) {
    chain = chain.registerStakeCertificate(next.rewardAddress);
  }

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
  const verb = currentIsV1 ? "Upgraded to" : "Downgraded to";
  console.log(`${verb} script logic v${currentIsV1 ? 2 : 1}. Tx:`, txHash);
}

export function prepare() {
  try {
    Deno.statSync("wallet.txt");
    console.log("wallet.txt already exists, skipping.");
    return;
  } catch { /* not found */ }
  const w = MeshWallet.brew(false) as string[];
  Deno.writeTextFileSync("wallet.txt", w.join(" "));
  console.log("Generated wallet.txt.");
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  try {
    if (cmd === "prepare") {
      prepare();
    } else if (cmd === "init") {
      await init();
    } else if (cmd === "mint") {
      if (!args[0]) throw new Error("Usage: mint <tokenUnit>");
      await mintToken(args[0]);
    } else if (cmd === "change-version") {
      if (!args[0]) throw new Error("Usage: change-version <tokenUnit>");
      await changeVersion(args[0]);
    } else {
      console.log(
        "Usage:\n" +
          "  prepare\n" +
          "  init\n" +
          "  mint <tokenUnit>\n" +
          "  change-version <tokenUnit>\n",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
