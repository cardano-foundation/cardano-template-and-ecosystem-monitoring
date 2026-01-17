import {
  Asset,
  BlockfrostProvider,
  type Data,
  deserializeAddress,
  mConStr0,
  mConStr1,
  MeshTxBuilder,
  MeshWallet,
  serializePlutusScript,
  stringToHex,
  type UTxO,
  YaciProvider,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";

const BLUEPRINT_PATH = new URL(
  "../../onchain/aiken/plutus.json",
  import.meta.url,
);

type Opts = Record<string, string | boolean | undefined>;

export function parseArgs(args: string[]): Opts {
  const out: Opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = args[i + 1];
    if (!v || v.startsWith("--")) {
      out[k] = true;
    } else {
      out[k] = v;
      i++;
    }
  }
  return out;
}

function getNetworkId(): 0 | 1 {
  const raw = Deno.env.get("NETWORK_ID") ?? "0";
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid NETWORK_ID: ${raw}`);
  return n === 1 ? 1 : 0;
}

function getProvider() {
  const blockfrost = Deno.env.get("BLOCKFROST_PROJECT_ID");
  if (blockfrost) return new BlockfrostProvider(blockfrost);
  const yaciUrl = Deno.env.get("YACI_URL") ??
    "https://yaci-node.meshjs.dev/api/v1/";
  return new YaciProvider(yaciUrl);
}

function getWallet(provider: any) {
  const networkId = getNetworkId();

  const root = Deno.env.get("ROOT_KEY_BECH32");
  if (root) {
    return new MeshWallet({
      networkId,
      fetcher: provider,
      submitter: provider,
      key: { type: "root", bech32: root },
    });
  }

  const mnemonicRaw = Deno.env.get("MNEMONIC");
  if (mnemonicRaw) {
    const words = mnemonicRaw.trim().split(/\s+/g);
    return new MeshWallet({
      networkId,
      fetcher: provider,
      submitter: provider,
      key: { type: "mnemonic", words },
    });
  }

  throw new Error(
    "Set either ROOT_KEY_BECH32 or MNEMONIC to run lock/set/delete.",
  );
}

async function readBlueprint(): Promise<any> {
  try {
    const raw = await Deno.readTextFile(BLUEPRINT_PATH);
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Could not read blueprint at ${BLUEPRINT_PATH.pathname}. Run 'aiken build' in storage/onchain/aiken.\nOriginal error: ${
        String(e)
      }`,
    );
  }
}

function plutusVersionFromBlueprint(blueprint: any): "V2" | "V3" {
  const pv = (blueprint?.preamble?.plutusVersion ?? "v3").toString()
    .toLowerCase();
  if (pv.includes("v2")) return "V2";
  return "V3";
}

async function getScript() {
  const blueprint = await readBlueprint();
  const version = plutusVersionFromBlueprint(blueprint);

  const scriptCbor = applyParamsToScript(
    blueprint.validators[0].compiledCode,
    [],
  );
  const scriptAddr =
    serializePlutusScript({ code: scriptCbor, version }).address;

  return { scriptCbor, scriptAddr, version };
}

function normalizeHexBytes(input: string): string {
  const s = input.trim();
  const no0x = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  const isHex = /^[0-9a-fA-F]*$/.test(no0x) && (no0x.length % 2 === 0);
  return isHex ? no0x : stringToHex(s);
}

function getKeyValueBytes(opts: Opts): { keyHex: string; valueHex: string } {
  const keyUtf8 = typeof opts["key-utf8"] === "string"
    ? String(opts["key-utf8"])
    : "";
  const valUtf8 = typeof opts["value-utf8"] === "string"
    ? String(opts["value-utf8"])
    : "";
  const keyHexRaw = typeof opts["key-hex"] === "string"
    ? String(opts["key-hex"])
    : "";
  const valHexRaw = typeof opts["value-hex"] === "string"
    ? String(opts["value-hex"])
    : "";

  const keySrc = keyHexRaw || keyUtf8;
  const valSrc = valHexRaw || valUtf8;

  if (!keySrc) throw new Error("Missing key: provide --key-utf8 or --key-hex");
  if (!valSrc) {
    throw new Error("Missing value: provide --value-utf8 or --value-hex");
  }

  return {
    keyHex: normalizeHexBytes(keySrc),
    valueHex: normalizeHexBytes(valSrc),
  };
}

function mkDatum(ownerPkh: string, keyHex: string, valueHex: string): Data {
  // StorageDatum ctor: 0, fields: [owner, key, value]
  return mConStr0([ownerPkh, keyHex, valueHex]);
}

function mkRedeemerSet(keyHex: string, valueHex: string): Data {
  // StorageAction.Set ctor: 0, fields: [key, value]
  return mConStr0([keyHex, valueHex]);
}

function mkRedeemerDelete(): Data {
  // StorageAction.Delete ctor: 1
  return mConStr1([]);
}

function mkTxBuilder(provider: any) {
  return new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    verbose: true,
  });
}

function selectCollateralUtxo(utxos: UTxO[]): UTxO {
  const u = utxos.find((x) =>
    Array.isArray(x.output.amount) &&
    x.output.amount.length === 1 &&
    x.output.amount[0]?.unit === "lovelace"
  );
  if (!u) {
    throw new Error(
      "No suitable collateral UTxO found (need a pure lovelace UTxO).",
    );
  }
  return u;
}

function parseUtxoRef(ref: string): { txHash: string; outputIndex: number } {
  const [txHash, idx] = ref.split("#");
  if (!txHash || idx === undefined) {
    throw new Error(`Invalid --utxo format: ${ref} (expected txHash#index)`);
  }
  const n = Number(idx);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid utxo index: ${idx}`);
  }
  return { txHash, outputIndex: n };
}

async function pickScriptUtxo(
  provider: any,
  scriptAddr: string,
  opts: Opts,
): Promise<UTxO> {
  const utxos = await provider.fetchAddressUTxOs(scriptAddr);

  const ref = typeof opts["utxo"] === "string" ? String(opts["utxo"]) : "";
  if (ref) {
    const want = parseUtxoRef(ref);
    const found = utxos.find((u: UTxO) =>
      u.input.txHash === want.txHash && u.input.outputIndex === want.outputIndex
    );
    if (!found) throw new Error(`Could not find requested script UTxO: ${ref}`);
    return found;
  }

  if (!utxos.length) {
    throw new Error("No UTxOs found at the script address. Run 'lock' first.");
  }
  return utxos[0];
}

export async function runLock(opts: Opts) {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const { scriptAddr } = await getScript();

  const amount = typeof opts["amount"] === "string"
    ? String(opts["amount"])
    : "2000000";
  const { keyHex, valueHex } = getKeyValueBytes(opts);

  const utxos = await wallet.getUtxos();
  const walletAddress = (await wallet.getUsedAddresses())[0];
  const signerHash = deserializeAddress(walletAddress).pubKeyHash;

  const datum = mkDatum(signerHash, keyHex, valueHex);
  const assets: Asset[] = [{ unit: "lovelace", quantity: amount }];

  const txBuilder = mkTxBuilder(provider);

  await txBuilder
    .txOut(scriptAddr, assets)
    .txOutDatumHashValue(datum)
    .changeAddress(walletAddress)
    .selectUtxosFrom(utxos)
    .complete();

  const unsignedTx = txBuilder.txHex;
  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);

  console.log(`Locked ${amount} lovelace at script. TxHash: ${txHash}`);
  console.log(`Script address: ${scriptAddr}`);
}

export async function runSet(opts: Opts) {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const { scriptAddr, scriptCbor, version } = await getScript();

  const { keyHex, valueHex } = getKeyValueBytes(opts);

  const walletUtxos = await wallet.getUtxos();
  const walletAddress = (await wallet.getUsedAddresses())[0];
  const signerHash = deserializeAddress(walletAddress).pubKeyHash;

  const scriptUtxo = await pickScriptUtxo(provider, scriptAddr, opts);

  const inputDatum = mkDatum(signerHash, keyHex, valueHex);
  const outputDatum = mkDatum(signerHash, keyHex, valueHex);
  const redeemer = mkRedeemerSet(keyHex, valueHex);
  const collateral = selectCollateralUtxo(walletUtxos);

  const txBuilder = mkTxBuilder(provider);
  if (version === "V2") txBuilder.spendingPlutusScriptV2();
  else txBuilder.spendingPlutusScriptV3();

  await txBuilder
    .txIn(
      scriptUtxo.input.txHash,
      scriptUtxo.input.outputIndex,
      scriptUtxo.output.amount,
      scriptUtxo.output.address,
    )
    .txInScript(scriptCbor)
    .txInDatumValue(inputDatum)
    .txInRedeemerValue(redeemer)
    // continuation output back to script (required by validator for Set)
    .txOut(scriptAddr, scriptUtxo.output.amount)
    .txOutDatumHashValue(outputDatum)
    .txInCollateral(
      collateral.input.txHash,
      collateral.input.outputIndex,
      collateral.output.amount,
      collateral.output.address,
    )
    .requiredSignerHash(signerHash)
    .changeAddress(walletAddress)
    .selectUtxosFrom(walletUtxos)
    .complete();

  const unsignedTx = txBuilder.txHex;
  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);

  console.log(`Set/update complete. TxHash: ${txHash}`);
}

export async function runDelete(opts: Opts) {
  const provider = getProvider();
  const wallet = getWallet(provider);
  const { scriptAddr, scriptCbor, version } = await getScript();

  const walletUtxos = await wallet.getUtxos();
  const walletAddress = (await wallet.getUsedAddresses())[0];
  const signerHash = deserializeAddress(walletAddress).pubKeyHash;

  const scriptUtxo = await pickScriptUtxo(provider, scriptAddr, opts);

  // for Delete, key/value not semantically used beyond owner signature check
  const inputDatum = mkDatum(signerHash, "", "");
  const redeemer = mkRedeemerDelete();
  const collateral = selectCollateralUtxo(walletUtxos);

  const txBuilder = mkTxBuilder(provider);
  if (version === "V2") txBuilder.spendingPlutusScriptV2();
  else txBuilder.spendingPlutusScriptV3();

  await txBuilder
    .txIn(
      scriptUtxo.input.txHash,
      scriptUtxo.input.outputIndex,
      scriptUtxo.output.amount,
      scriptUtxo.output.address,
    )
    .txInScript(scriptCbor)
    .txInDatumValue(inputDatum)
    .txInRedeemerValue(redeemer)
    // no continuation output back to script (required by validator for Delete)
    .txInCollateral(
      collateral.input.txHash,
      collateral.input.outputIndex,
      collateral.output.amount,
      collateral.output.address,
    )
    .requiredSignerHash(signerHash)
    .changeAddress(walletAddress)
    .selectUtxosFrom(walletUtxos)
    .complete();

  const unsignedTx = txBuilder.txHex;
  const signedTx = await wallet.signTx(unsignedTx);
  const txHash = await wallet.submitTx(signedTx);

  console.log(`Delete/close complete. TxHash: ${txHash}`);
}
