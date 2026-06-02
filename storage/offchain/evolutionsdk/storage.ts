import {
  Lucid,
  Blockfrost,
  applyParamsToScript,
  Constr,
  Data,
  fromText,
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
// Immutable on-chain snapshot registry. Mint policy is parameterised by a
// seed OutputReference (one-shot per publish) plus the storage script hash;
// the storage validator is always-fail, so once a registry NFT is minted to
// it the inline datum is frozen forever.
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

function getValidator(prefix: string): string {
  const v = blueprint.validators.find((x) => x.title.startsWith(prefix));
  if (!v) throw new Error(`Validator not found: ${prefix}`);
  return v.compiledCode;
}

function buildOutputReference(txHash: string, idx: number): Constr<Data> {
  return new Constr(0, [txHash, BigInt(idx)]);
}

function getStorageScript(): { script: Script; address: string; hash: string } {
  const script: Script = { type: "PlutusV3", script: getValidator("storage.") };
  return {
    script,
    address: validatorToAddress(NETWORK, script),
    hash: validatorToScriptHash(script),
  };
}

function getMintScript(seedUtxo: UTxO, storageHash: string): Script {
  return {
    type: "PlutusV3",
    script: applyParamsToScript(getValidator("mint."), [
      buildOutputReference(seedUtxo.txHash, seedUtxo.outputIndex),
      storageHash,
    ]),
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type SnapshotKind = "daily" | "monthly";
function snapshotTypeConstr(kind: SnapshotKind): Constr<Data> {
  return new Constr(kind === "daily" ? 0 : 1, []);
}

async function publish(
  lucid: LucidEvolution,
  snapshotId: string,
  kind: SnapshotKind,
  commitmentHexHash: string,
) {
  const ownerAddr = await lucid.wallet().address();
  const utxos = await lucid.utxosAt(ownerAddr);
  if (utxos.length === 0) throw new Error("No wallet UTxOs available");
  const seedUtxo = utxos[0];

  const storage = getStorageScript();
  const mintScript = getMintScript(seedUtxo, storage.hash);
  const policyId = validatorToScriptHash(mintScript);

  const assetNameHex = await sha256Hex(new TextEncoder().encode(snapshotId));
  const tokenUnit = policyId + assetNameHex;
  const snapshotIdHex = fromText(snapshotId);
  const publishedAt = BigInt(Date.now());

  const registryDatum = Data.to(
    new Constr(0, [snapshotIdHex, snapshotTypeConstr(kind), commitmentHexHash, publishedAt]),
  );
  const mintRedeemer = Data.to(
    new Constr(0, [snapshotIdHex, snapshotTypeConstr(kind), commitmentHexHash]),
  );

  const tx = await lucid
    .newTx()
    .collectFrom([seedUtxo])
    .mintAssets({ [tokenUnit]: 1n }, mintRedeemer)
    .attach.MintingPolicy(mintScript)
    .pay.ToContract(
      storage.address,
      { kind: "inline", value: registryDatum },
      { [tokenUnit]: 1n },
    )
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`PUBLISH ${kind} ok. snapshot_id=${snapshotId} asset=${assetNameHex.slice(0, 16)}… tx=${txHash}`);
  return txHash;
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

async function runScenario() {
  console.log("=== storage scenario: publish daily → publish monthly ===");
  const lucid = await lucidAt(0);
  const addr = await lucid.wallet().address();

  const commit1 = "a".repeat(64);
  const commit2 = "b".repeat(64);
  await publish(lucid, `snap-${Date.now()}-daily`, "daily", commit1);
  // Each publish consumes its own seed UTxO; wait for the change UTxO from
  // the first publish before reading wallet utxos for the second.
  await waitForUtxosAt(lucid, addr, 1, 60);
  await new Promise((r) => setTimeout(r, 2000));
  await publish(lucid, `snap-${Date.now()}-monthly`, "monthly", commit2);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
