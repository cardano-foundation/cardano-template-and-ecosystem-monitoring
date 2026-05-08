import {
  Lucid,
  Koios,
  applyParamsToScript,
  Constr,
  Data,
  fromText,
  generateSeedPhrase,
  getAddressDetails,
  mintingPolicyToId,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Token-transfer — Evolution SDK port.
//
// Validator parameters: (receiver: VKH, policy: PolicyId, assetName: ByteArray)
// Spend rule: spending a UTxO with assets under `policy` and name `assetName`
//             succeeds iff (a) outputs sent to *other* addresses contain only
//             that exact asset, and (b) `receiver` is in extra_signatories.
// Mint policy: an always-true PlutusV3 script (cborHex 46450101002499).
//
// Happy path: prepare wallet → mint TestAsset → lock at script with unit datum
//             → unlock back to receiver.
// ----------------------------------------------------------------------------

const KOIOS_URL = "https://preprod.koios.rest/api/v1";
const ASSET_NAME = "TestAsset";

// Always-succeeds PlutusV3 minting policy (matches the CCL Java reference).
const ALWAYS_TRUE_SCRIPT: Script = {
  type: "PlutusV3",
  script: "46450101002499",
};

function selectWallet(lucid: LucidEvolution, fileName = "wallet.txt") {
  const mnemonic = Deno.readTextFileSync(fileName).trim();
  lucid.selectWallet.fromSeed(mnemonic);
}

async function prepare() {
  const fileName = "wallet.txt";
  try {
    await Deno.stat(fileName);
    console.log(`${fileName} already exists, skipping.`);
    return;
  } catch { /* not found, generate */ }

  const mnemonic = generateSeedPhrase();
  await Deno.writeTextFile(fileName, mnemonic);
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  lucid.selectWallet.fromSeed(mnemonic);
  console.log(`Generated ${fileName}. Address: ${await lucid.wallet().address()}`);
}

function loadValidator(receiverVkh: string, policyId: string): {
  validator: Script;
  scriptAddress: string;
} {
  const compiledCode = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(compiledCode, [
    receiverVkh,
    policyId,
    fromText(ASSET_NAME),
  ]);
  const validator: Script = { type: "PlutusV3", script };
  const scriptAddress = validatorToAddress("Preprod", validator);
  return { validator, scriptAddress };
}

async function mint() {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const myAddr = await lucid.wallet().address();
  const policyId = mintingPolicyToId(ALWAYS_TRUE_SCRIPT);
  const unit = policyId + fromText(ASSET_NAME);

  const tx = await lucid
    .newTx()
    .mintAssets({ [unit]: 10n }, Data.void())
    .attach.MintingPolicy(ALWAYS_TRUE_SCRIPT)
    .pay.ToAddress(myAddr, { [unit]: 10n })
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Mint submitted. Tx: ${txHash}`);
  console.log(`Asset unit: ${unit}`);
}

async function lock() {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const myAddr = await lucid.wallet().address();
  const myVkh = getAddressDetails(myAddr).paymentCredential!.hash;
  const policyId = validatorToScriptHash(ALWAYS_TRUE_SCRIPT);
  const unit = policyId + fromText(ASSET_NAME);

  const { scriptAddress } = loadValidator(myVkh, policyId);

  const utxos = await lucid.utxosAtWithUnit(myAddr, unit);
  if (utxos.length === 0) throw new Error("No UTxO with the minted asset found in wallet");
  const tokenUtxo = utxos[0];
  const tokenAmount = tokenUtxo.assets[unit];

  const tx = await lucid
    .newTx()
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.void() },
      { [unit]: tokenAmount },
    )
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Lock submitted. Tx: ${txHash}`);
  console.log(`Script address: ${scriptAddress}`);
}

async function unlock() {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const myAddr = await lucid.wallet().address();
  const myVkh = getAddressDetails(myAddr).paymentCredential!.hash;
  const policyId = validatorToScriptHash(ALWAYS_TRUE_SCRIPT);
  const unit = policyId + fromText(ASSET_NAME);

  const { validator, scriptAddress } = loadValidator(myVkh, policyId);

  const scriptUtxos = await lucid.utxosAt(scriptAddress);
  const utxo = scriptUtxos.find((u) => u.assets[unit] !== undefined);
  if (!utxo) throw new Error("No script UTxO holding the asset found");

  // Send the locked asset back to the receiver. ADA flows to change.
  const tokenAmount = utxo.assets[unit];

  const tx = await lucid
    .newTx()
    .collectFrom([utxo], Data.void())
    .attach.SpendingValidator(validator)
    .pay.ToAddress(myAddr, { [unit]: tokenAmount })
    .addSigner(myAddr)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Unlock submitted. Tx: ${txHash}`);
}

if (import.meta.main) {
  const [cmd] = Deno.args;
  if (!cmd) {
    console.log(
      "Usage:\n" +
        "  prepare              # generate wallet.txt seed phrase\n" +
        "  mint                 # mint 10 TestAsset to your wallet\n" +
        "  lock                 # lock the minted asset at the script\n" +
        "  unlock               # unlock the asset back to your wallet\n",
    );
  } else if (cmd === "prepare") {
    await prepare();
  } else if (cmd === "mint") {
    await mint();
  } else if (cmd === "lock") {
    await lock();
  } else if (cmd === "unlock") {
    await unlock();
  } else {
    console.log("Unknown command");
  }
}
