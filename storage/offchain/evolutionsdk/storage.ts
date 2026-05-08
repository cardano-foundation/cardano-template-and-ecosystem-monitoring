import {
  Lucid,
  Koios,
  applyParamsToScript,
  Constr,
  Data,
  fromText,
  generateSeedPhrase,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
  type UTxO,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Storage — Evolution SDK port.
//
// Two validators:
//   storage (spend): no parameters, ALWAYS FAILS — script UTxOs are immutable.
//   mint    (mint):  params (seed_utxo: OutputReference, storage_validator_hash: ByteArray)
//                    one-shot policy: requires consuming `seed_utxo`, mints exactly 1
//                    token whose asset name = sha2_256(snapshot_id), output to storage
//                    validator with RegistryDatum.
//
// RegistryDatum = Constr 0 [snapshot_id, snapshot_type, commitment_hash, published_at]
// SnapshotType  = Constr 0 [] (Daily) | Constr 1 [] (Monthly)
// MintRedeemer  = Constr 0 [snapshot_id, snapshot_type, commitment_hash]
//
// Operations:
//   prepare   generate wallet.json
//   publish   one-shot publish a snapshot (mint + lock)
// ----------------------------------------------------------------------------

const KOIOS_URL = "https://preprod.koios.rest/api/v1";

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
  return new Constr(0, [txHash, BigInt(idx)]);
}

function getStorageScript(): { script: Script; address: string; hash: string } {
  const script: Script = { type: "PlutusV3", script: getValidator("storage.") };
  return {
    script,
    address: validatorToAddress("Preprod", script),
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

async function sha256(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type SnapshotKind = "daily" | "monthly";
function snapshotTypeConstr(kind: SnapshotKind): Constr<Data> {
  return new Constr(kind === "daily" ? 0 : 1, []);
}

export async function publish(
  snapshotId: string,
  kind: SnapshotKind,
  commitmentHexHash: string, // 32-byte sha256, lowercase hex
) {
  if (commitmentHexHash.length !== 64) {
    throw new Error("commitmentHexHash must be 32 bytes (64 hex chars)");
  }

  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerAddr = await lucid.wallet().address();

  const utxos = await lucid.utxosAt(ownerAddr);
  if (utxos.length === 0) throw new Error("No wallet UTxOs available");
  const seedUtxo = utxos[0];

  const storage = getStorageScript();
  const mintScript = getMintScript(seedUtxo, storage.hash);
  const policyId = validatorToScriptHash(mintScript);

  // Asset name = sha2_256(snapshot_id)
  const snapshotIdBytes = new TextEncoder().encode(snapshotId);
  const assetNameHex = await sha256(snapshotIdBytes);
  const tokenUnit = policyId + assetNameHex;

  const snapshotIdHex = fromText(snapshotId);
  const publishedAt = BigInt(Date.now());

  // RegistryDatum = Constr 0 [snapshot_id, snapshot_type, commitment_hash, published_at]
  const registryDatum = Data.to(
    new Constr(0, [snapshotIdHex, snapshotTypeConstr(kind), commitmentHexHash, publishedAt]),
  );

  // MintRedeemer = Constr 0 [snapshot_id, snapshot_type, commitment_hash]
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

  console.log("Snapshot published");
  console.log("Storage address:", storage.address);
  console.log("Mint policy:", policyId);
  console.log("Asset (sha256(id)):", assetNameHex);
  console.log("Tx:", txHash);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  try {
    if (cmd === "prepare") {
      await prepare();
    } else if (cmd === "publish") {
      if (args.length !== 3) {
        throw new Error(
          "Usage: publish <snapshot_id> <daily|monthly> <commitment_sha256_hex>",
        );
      }
      const kind = args[1] as SnapshotKind;
      if (kind !== "daily" && kind !== "monthly") {
        throw new Error('snapshot_type must be "daily" or "monthly"');
      }
      await publish(args[0], kind, args[2]);
    } else {
      console.log(
        "Usage:\n" +
          "  prepare\n" +
          "  publish <snapshot_id> <daily|monthly> <commitment_sha256_hex>\n",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
