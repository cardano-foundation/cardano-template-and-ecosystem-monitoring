import {
  KoiosProvider,
  MeshTxBuilder,
  MeshWallet,
  mConStr0,
  resolvePaymentKeyHash,
  resolveScriptHash,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Token-transfer — Mesh.js port.
//
// Validator parameters: (receiver: VKH, policy: PolicyId, assetName: ByteArray)
// Spend rule: outputs sent to *other* addresses must contain only the policy's
//             expected asset, and `receiver` must be in extra_signatories.
// Mint policy: an always-true PlutusV3 script (cborHex 46450101002499).
//
// Operations: prepare → mint → lock → unlock.
// ----------------------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;
const ASSET_NAME = "TestAsset";
const ALWAYS_TRUE_SCRIPT_CBOR = "46450101002499";

function loadWallet(walletFile: string): MeshWallet {
  const mnemonic = JSON.parse(Deno.readTextFileSync(walletFile));
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: new KoiosProvider(NETWORK),
    submitter: new KoiosProvider(NETWORK),
    key: { type: "mnemonic", words: mnemonic },
  });
}

async function prepare(walletFile: string) {
  try {
    await Deno.stat(walletFile);
    console.log(`${walletFile} already exists, skipping.`);
    return;
  } catch { /* not found */ }

  // Reuse Mesh's mnemonic generator.
  const w = MeshWallet.brew(false) as string[];
  await Deno.writeTextFile(walletFile, JSON.stringify(w));
  console.log(`Generated ${walletFile}.`);
}

function getAlwaysTruePolicyId(): string {
  return resolveScriptHash(ALWAYS_TRUE_SCRIPT_CBOR, "V3");
}

function loadValidator(receiverVkh: string, policyId: string) {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(
    compiled,
    [receiverVkh, policyId, stringToHex(ASSET_NAME)],
    "JSON",
  );
  const { address: scriptAddress } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, scriptAddress };
}

export async function mint(walletFile: string) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);

  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const policyId = getAlwaysTruePolicyId();
  const unit = policyId + stringToHex(ASSET_NAME);

  const utxos = await provider.fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .mintPlutusScriptV3()
    .mint("10", policyId, stringToHex(ASSET_NAME))
    .mintingScript(ALWAYS_TRUE_SCRIPT_CBOR)
    // Always-true policy ignores its redeemer; supply unit.
    .mintRedeemerValue(mConStr0([]), "JSON")
    .txOut(myAddr, [{ unit, quantity: "10" }])
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(myVkh)
    .changeAddress(myAddr)
    .selectUtxosFrom(utxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Mint submitted. Tx: ${txHash}`);
  console.log(`Asset unit: ${unit}`);
}

export async function lock(walletFile: string) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);

  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const policyId = getAlwaysTruePolicyId();
  const unit = policyId + stringToHex(ASSET_NAME);

  const { scriptAddress } = loadValidator(myVkh, policyId);

  const allUtxos = await provider.fetchAddressUTxOs(myAddr);
  const tokenUtxo = allUtxos.find((u) =>
    u.output.amount.some((a) => a.unit === unit),
  );
  if (!tokenUtxo) throw new Error("No UTxO with the minted asset found in wallet");
  const tokenAmount = tokenUtxo.output.amount.find((a) => a.unit === unit)!.quantity;

  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .txOut(scriptAddress, [{ unit, quantity: tokenAmount }])
    .txOutInlineDatumValue(mConStr0([]), "JSON")
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(myVkh)
    .changeAddress(myAddr)
    .selectUtxosFrom(allUtxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Lock submitted. Tx: ${txHash}`);
  console.log(`Script address: ${scriptAddress}`);
}

export async function unlock(walletFile: string) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);

  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const policyId = getAlwaysTruePolicyId();
  const unit = policyId + stringToHex(ASSET_NAME);

  const { script, scriptAddress } = loadValidator(myVkh, policyId);

  const scriptUtxos = await provider.fetchAddressUTxOs(scriptAddress);
  const utxo = scriptUtxos.find((u) =>
    u.output.amount.some((a) => a.unit === unit),
  );
  if (!utxo) throw new Error("No script UTxO holding the asset found");
  const tokenAmount = utxo.output.amount.find((a) => a.unit === unit)!.quantity;

  const ownUtxos = await provider.fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
    .txInScript(script)
    .txInRedeemerValue(mConStr0([]), "JSON")
    .txInInlineDatumPresent()
    .txOut(myAddr, [{ unit, quantity: tokenAmount }])
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(myVkh)
    .changeAddress(myAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Unlock submitted. Tx: ${txHash}`);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  if (!cmd) {
    console.log(
      "Usage:\n" +
        "  prepare <wallet.json>\n" +
        "  mint <wallet.json>\n" +
        "  lock <wallet.json>\n" +
        "  unlock <wallet.json>\n",
    );
  } else if (cmd === "prepare") {
    if (!args[0]) console.error("Usage: prepare <wallet.json>");
    else await prepare(args[0]);
  } else if (cmd === "mint") {
    if (!args[0]) console.error("Usage: mint <wallet.json>");
    else await mint(args[0]);
  } else if (cmd === "lock") {
    if (!args[0]) console.error("Usage: lock <wallet.json>");
    else await lock(args[0]);
  } else if (cmd === "unlock") {
    if (!args[0]) console.error("Usage: unlock <wallet.json>");
    else await unlock(args[0]);
  } else {
    console.log("Unknown command");
  }
}
