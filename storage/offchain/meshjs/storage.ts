import {
  KoiosProvider,
  MeshTxBuilder,
  MeshWallet,
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

// ----------------------------------------------------------------------------
// Storage — Mesh.js port.
//
// Two validators:
//   storage (spend): no parameters, ALWAYS FAILS — script UTxOs are immutable.
//   mint    (mint):  params (seed_utxo: OutputReference, storage_validator_hash: ByteArray)
//                    one-shot policy: requires consuming `seed_utxo`, mints exactly 1
//                    token whose asset name = sha2_256(snapshot_id), output to storage
//                    validator with RegistryDatum.
//
// Operation: publish (one-shot mint + lock).
// ----------------------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;

function loadWallet(walletFile: string): MeshWallet {
  const mnemonic = JSON.parse(Deno.readTextFileSync(walletFile));
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: new KoiosProvider(NETWORK),
    submitter: new KoiosProvider(NETWORK),
    key: { type: "mnemonic", words: mnemonic },
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

export async function publish(
  walletFile: string,
  snapshotId: string,
  kind: "daily" | "monthly",
  commitmentHexHash: string,
) {
  if (commitmentHexHash.length !== 64) {
    throw new Error("commitmentHexHash must be 32 bytes (64 hex chars)");
  }

  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);

  const ownerAddr = await wallet.getChangeAddress();
  const utxos = await provider.fetchAddressUTxOs(ownerAddr);
  if (utxos.length === 0) throw new Error("No wallet UTxOs available");
  const seedUtxo = utxos[0];

  const { storageAddress, storageHash } = getStorageInfo();

  const mintScript = applyParamsToScript(
    getValidator("mint."),
    [
      outputReference(seedUtxo.input.txHash, seedUtxo.input.outputIndex),
      storageHash,
    ],
    "JSON",
  );
  const policyId = resolveScriptHash(mintScript, "V3");

  const snapshotIdHex = stringToHex(snapshotId);
  const assetNameHex = await sha256Hex(new TextEncoder().encode(snapshotId));
  const tokenUnit = policyId + assetNameHex;
  const publishedAt = Date.now();

  // SnapshotType: Constr 0 [] (Daily) | Constr 1 [] (Monthly)
  const snapshotTypeData = mConStr(kind === "daily" ? 0 : 1, []);

  // RegistryDatum = Constr 0 [snapshot_id, snapshot_type, commitment_hash, published_at]
  const registryDatum = mConStr0([
    snapshotIdHex,
    snapshotTypeData,
    commitmentHexHash,
    publishedAt,
  ]);

  // MintRedeemer = Constr 0 [snapshot_id, snapshot_type, commitment_hash]
  const mintRedeemer = mConStr0([snapshotIdHex, snapshotTypeData, commitmentHexHash]);

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
    .mintPlutusScriptV3()
    .mint("1", policyId, assetNameHex)
    .mintingScript(mintScript)
    .mintRedeemerValue(mintRedeemer, "JSON")
    .txOut(storageAddress, [{ unit: tokenUnit, quantity: "1" }])
    .txOutInlineDatumValue(registryDatum, "JSON")
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

  console.log("Snapshot published");
  console.log("Storage address:", storageAddress);
  console.log("Mint policy:", policyId);
  console.log("Asset (sha256(id)):", assetNameHex);
  console.log("Tx:", txHash);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  try {
    if (cmd === "publish") {
      if (args.length !== 4) {
        throw new Error(
          "Usage: publish <wallet.json> <snapshot_id> <daily|monthly> <commitment_sha256_hex>",
        );
      }
      const kind = args[2] as "daily" | "monthly";
      if (kind !== "daily" && kind !== "monthly") {
        throw new Error('snapshot_type must be "daily" or "monthly"');
      }
      await publish(args[0], args[1], kind, args[3]);
    } else {
      console.log(
        "Usage:\n" +
          "  publish <wallet.json> <snapshot_id> <daily|monthly> <commitment_sha256_hex>\n",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
