import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  mConStr,
  mConStr0,
  outputReference,
  resolveScriptHash,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Storage: one-shot mint of a snapshot token, locked at an always-fail spend address (immutable).
// Scenario publishes both Daily and Monthly variants.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const FUNDER_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

function provider(): BlockfrostProvider {
  return new BlockfrostProvider(YACI_URL);
}

function funderWallet(): MeshWallet {
  const p = provider();
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: p,
    submitter: p,
    key: { type: "mnemonic", words: FUNDER_MNEMONIC.split(/\s+/) },
  });
}

function getValidator(prefix: string): string {
  const v = blueprint.validators.find((x) => x.title.startsWith(prefix));
  if (!v) throw new Error(`Validator not found: ${prefix}`);
  return v.compiledCode;
}

function getStorageInfo() {
  const compiled = getValidator("storage.");
  const storageHash = resolveScriptHash(compiled, "V3");
  const { address: storageAddress } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { storageAddress, storageHash };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

async function publish(
  wallet: MeshWallet,
  snapshotId: string,
  kind: "daily" | "monthly",
  commitmentHexHash: string,
) {
  const ownerAddr = await wallet.getChangeAddress();
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);
  if (utxos.length === 0) throw new Error("No wallet UTxOs available");
  const seedUtxo = utxos[0];

  const { storageAddress, storageHash } = getStorageInfo();
  const mintScript = applyParamsToScript(
    getValidator("mint."),
    [
      outputReference(seedUtxo.input.txHash, seedUtxo.input.outputIndex),
      builtinByteString(storageHash),
    ],
    "JSON",
  );
  const policyId = resolveScriptHash(mintScript, "V3");
  const snapshotIdHex = stringToHex(snapshotId);
  const assetNameHex = await sha256Hex(new TextEncoder().encode(snapshotId));
  const tokenUnit = policyId + assetNameHex;
  const publishedAt = Date.now();

  const snapshotTypeData = mConStr(kind === "daily" ? 0 : 1, []);
  const registryDatum = mConStr0([
    snapshotIdHex,
    snapshotTypeData,
    commitmentHexHash,
    publishedAt,
  ]);
  const mintRedeemer = mConStr0([snapshotIdHex, snapshotTypeData, commitmentHexHash]);
  const collateral: UTxO[] = await wallet.getCollateral();

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txIn(
      seedUtxo.input.txHash,
      seedUtxo.input.outputIndex,
      seedUtxo.output.amount,
      seedUtxo.output.address,
    )
    .mintPlutusScriptV3()
    .mint("1", policyId, assetNameHex)
    // Inline minting script (vs. mintTxInReference): the seed-UTxO param makes this policy
    // single-use, so a reference UTxO would be wasted setup.
    .mintingScript(mintScript)
    .mintRedeemerValue(mintRedeemer)
    .txOut(storageAddress, [{ unit: tokenUnit, quantity: "1" }])
    .txOutInlineDatumValue(registryDatum)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`PUBLISH ${kind} ok. snapshot_id=${snapshotId} asset=${assetNameHex.slice(0, 16)}… tx=${txHash}`);
}

async function runScenario() {
  console.log("=== storage scenario: publish daily → publish monthly ===");
  const wallet = funderWallet();
  const addr = await wallet.getChangeAddress();
  await publish(wallet, `snap-${Date.now()}-daily`, "daily", "a".repeat(64));
  await waitForUtxoAt(addr, 1, 60);
  await new Promise((r) => setTimeout(r, 2000));
  await publish(wallet, `snap-${Date.now()}-monthly`, "monthly", "b".repeat(64));
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
