import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  deserializeAddress,
  deserializeDatum,
  mConStr0,
  mConStr1,
  mPubKeyAddress,
  resolvePaymentKeyHash,
  resolveScriptHash,
  scriptHash,
  serializeAddressObj,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Simple wallet: 3 chained validators (intent, wallet-mint, funds).
// Scenario: add-funds → create-intent → execute → add-funds → withdraw.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const INTENT_ASSETNAME = "INTENT_MARKER";
const FUNDER_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const VALIDATOR_INDEX = { funds: 0, intent: 2, wallet: 4 } as const;

function provider(): BlockfrostProvider {
  return new BlockfrostProvider(YACI_URL);
}
function makeWallet(words: string[]): MeshWallet {
  const p = provider();
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: p,
    submitter: p,
    key: { type: "mnemonic", words },
  });
}
function funderWallet(): MeshWallet {
  return makeWallet(FUNDER_MNEMONIC.split(/\s+/));
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

async function fundFromFunder(targetAddr: string, lovelace: bigint) {
  const wallet = funderWallet();
  const myAddr = await wallet.getChangeAddress();
  const myUtxos = await provider().fetchAddressUTxOs(myAddr);
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(targetAddr, [{ unit: "lovelace", quantity: lovelace.toString() }])
    .changeAddress(myAddr)
    .selectUtxosFrom(myUtxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Funded ${targetAddr.slice(0, 20)}… with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxoAt(targetAddr, 1);
}

function getScriptAddress(compiled: string) {
  const { address } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return address;
}

function loadScripts(ownerPkh: string) {
  const code = (k: keyof typeof VALIDATOR_INDEX) =>
    blueprint.validators[VALIDATOR_INDEX[k]].compiledCode;
  const intentScript = applyParamsToScript(
    code("intent"),
    [builtinByteString(ownerPkh)],
    "JSON",
  );
  const intentHash = resolveScriptHash(intentScript, "V3");
  const walletScript = applyParamsToScript(
    code("wallet"),
    [builtinByteString(ownerPkh), scriptHash(intentHash)],
    "JSON",
  );
  const walletHash = resolveScriptHash(walletScript, "V3");
  const fundsScript = applyParamsToScript(
    code("funds"),
    [builtinByteString(ownerPkh), scriptHash(walletHash)],
    "JSON",
  );
  return {
    intent: { script: intentScript, address: getScriptAddress(intentScript) },
    wallet: { script: walletScript, policyId: walletHash },
    funds: { script: fundsScript, address: getScriptAddress(fundsScript) },
  };
}

async function addFunds(wallet: MeshWallet, lovelace: bigint) {
  const changeAddr = await wallet.getChangeAddress();
  const ownerPkh = resolvePaymentKeyHash(changeAddr);
  const scripts = loadScripts(ownerPkh);
  const utxos = await provider().fetchAddressUTxOs(changeAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scripts.funds.address, [{ unit: "lovelace", quantity: lovelace.toString() }])
    .txOutInlineDatumValue(mConStr0([0, []]))
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerPkh)
    .changeAddress(changeAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`ADD_FUNDS ok. amount=${lovelace} tx=${txHash}`);
}

async function createIntent(
  wallet: MeshWallet,
  recipientAddr: string,
  lovelace: bigint,
  data: string,
) {
  const changeAddr = await wallet.getChangeAddress();
  const ownerPkh = resolvePaymentKeyHash(changeAddr);
  const scripts = loadScripts(ownerPkh);
  const utxos = await provider().fetchAddressUTxOs(changeAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const recipient = deserializeAddress(recipientAddr);
  // mPubKeyAddress emits Mesh-shape {alternative,fields} — fine here because the surrounding
  // datum is built via mConStr0 (also Mesh-shape). Mixing JSON-shape would break encoding.
  const intentDatum = mConStr0([
    mPubKeyAddress(recipient.pubKeyHash, recipient.stakeCredentialHash),
    Number(lovelace),
    stringToHex(data),
  ]);

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .mintPlutusScriptV3()
    .mint("1", scripts.wallet.policyId, stringToHex(INTENT_ASSETNAME))
    // Inline minting script (vs. mintTxInReference): the wallet validator is small and only used
    // here; publishing a reference UTxO is extra ceremony for the same effect.
    .mintingScript(scripts.wallet.script)
    .mintRedeemerValue(mConStr0([]))
    .txOut(scripts.intent.address, [
      { unit: scripts.wallet.policyId + stringToHex(INTENT_ASSETNAME), quantity: "1" },
    ])
    .txOutInlineDatumValue(intentDatum)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerPkh)
    .changeAddress(changeAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`CREATE_INTENT ok. tx=${txHash}`);
}

async function executeIntent(wallet: MeshWallet) {
  const changeAddr = await wallet.getChangeAddress();
  const ownerPkh = resolvePaymentKeyHash(changeAddr);
  const scripts = loadScripts(ownerPkh);

  const fundsUtxos = await provider().fetchAddressUTxOs(scripts.funds.address);
  const intentUtxos = await provider().fetchAddressUTxOs(scripts.intent.address);
  const walletUtxos = await provider().fetchAddressUTxOs(changeAddr);
  const collateral: UTxO[] = await wallet.getCollateral();
  if (!fundsUtxos.length || !intentUtxos.length) throw new Error("Missing funds/intent UTxO");

  const fundsUtxo = fundsUtxos[0];
  if (!fundsUtxo.output.plutusData) throw new Error("Funds UTxO missing datum");
  const intentUtxo = intentUtxos.find((u) =>
    u.output.amount.some((a) => a.unit.endsWith(stringToHex(INTENT_ASSETNAME)) && a.quantity === "1"),
  );
  if (!intentUtxo || !intentUtxo.output.plutusData) throw new Error("Intent UTxO missing");

  const datum = deserializeDatum(intentUtxo.output.plutusData);
  // datum.fields[0] is JSON-shape after deserializeDatum; serializeAddressObj wants exactly that.
  // Building this Address with mPubKeyAddress would yield Mesh-shape and crash here.
  const payeeAddress = serializeAddressObj(datum.fields[0]);
  const lovelace = Number(datum.fields[1].int).toString();

  // Multiple Plutus scripts in one tx — default per-redeemer budget × N exceeds the tx limit,
  // so set conservative explicit exUnits per call.
  const exUnits = { mem: 3_000_000, steps: 1_500_000_000 };

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(fundsUtxo.input.txHash, fundsUtxo.input.outputIndex, fundsUtxo.output.amount, scripts.funds.address)
    .txInInlineDatumPresent()
    .txInRedeemerValue(mConStr0([]), "Mesh", exUnits)
    .txInScript(scripts.funds.script)
    .spendingPlutusScriptV3()
    .txIn(intentUtxo.input.txHash, intentUtxo.input.outputIndex, intentUtxo.output.amount, scripts.intent.address)
    .txInInlineDatumPresent()
    .txInRedeemerValue("SomeRedeemer", "Mesh", exUnits)
    .txInScript(scripts.intent.script)
    .txOut(payeeAddress, [{ unit: "lovelace", quantity: lovelace }])
    .mintPlutusScriptV3()
    .mint("-1", scripts.wallet.policyId, stringToHex(INTENT_ASSETNAME))
    .mintingScript(scripts.wallet.script)
    .mintRedeemerValue(mConStr1([]), "Mesh", exUnits)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerPkh)
    .changeAddress(changeAddr)
    .selectUtxosFrom(walletUtxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex, true);
  const txHash = await wallet.submitTx(signed);
  console.log(`EXECUTE ok. paid ${lovelace} to recipient. tx=${txHash}`);
}

async function withdrawAll(wallet: MeshWallet) {
  const changeAddr = await wallet.getChangeAddress();
  const ownerPkh = resolvePaymentKeyHash(changeAddr);
  const scripts = loadScripts(ownerPkh);
  const fundsUtxos = await provider().fetchAddressUTxOs(scripts.funds.address);
  if (!fundsUtxos.length) throw new Error("No funds");
  const walletUtxos = await provider().fetchAddressUTxOs(changeAddr);
  const collateral: UTxO[] = await wallet.getCollateral();
  const fundsUtxo = fundsUtxos[0];

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(fundsUtxo.input.txHash, fundsUtxo.input.outputIndex, fundsUtxo.output.amount, scripts.funds.address)
    .txInInlineDatumPresent()
    .txInRedeemerValue(mConStr1([]))
    .txInScript(scripts.funds.script)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerPkh)
    .changeAddress(changeAddr)
    .selectUtxosFrom(walletUtxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex, true);
  const txHash = await wallet.submitTx(signed);
  console.log(`WITHDRAW ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== simple-wallet scenario: add-funds → create-intent → execute → add-funds → withdraw ===");
  // Roles: owner runs all wallet ops; recipient just receives the intent payout.
  const owner = makeWallet(MeshWallet.brew(false) as string[]);
  const recipient = makeWallet(MeshWallet.brew(false) as string[]);
  await fundFromFunder(await owner.getChangeAddress(), 100_000_000n);

  await addFunds(owner, 20_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await createIntent(owner, await recipient.getChangeAddress(), 5_000_000n, "test-payment");
  await new Promise((r) => setTimeout(r, 2000));
  await executeIntent(owner);
  await new Promise((r) => setTimeout(r, 2000));
  await addFunds(owner, 10_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await withdrawAll(owner);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
