import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  mConStr0,
  resolvePaymentKeyHash,
  resolveScriptHash,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Token transfer: mint TestAsset via always-true policy → lock at script → unlock to receiver.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const ASSET_NAME = "TestAsset";
const ALWAYS_TRUE_SCRIPT_CBOR = "46450101002499";
const FUNDER_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

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

function getAlwaysTruePolicyId(): string {
  return resolveScriptHash(ALWAYS_TRUE_SCRIPT_CBOR, "V3");
}

function loadValidator(receiverVkh: string, policyId: string) {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(
    compiled,
    [
      builtinByteString(receiverVkh),
      builtinByteString(policyId),
      builtinByteString(stringToHex(ASSET_NAME)),
    ],
    "JSON",
  );
  const { address: scriptAddress } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, scriptAddress };
}

async function mint(wallet: MeshWallet, unit: string): Promise<void> {
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const policyId = getAlwaysTruePolicyId();
  const utxos = await provider().fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .mintPlutusScriptV3()
    .mint("10", policyId, stringToHex(ASSET_NAME))
    // Inline minting script (vs. mintTxInReference): the always-true CBOR is tiny — referencing it
    // would mean a setup tx to publish a script that's effectively free to inline.
    .mintingScript(ALWAYS_TRUE_SCRIPT_CBOR)
    .mintRedeemerValue(mConStr0([]))
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
  console.log(`MINT ok. unit=${unit.slice(0, 24)}… tx=${txHash}`);
}

async function lock(wallet: MeshWallet, unit: string): Promise<string> {
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const policyId = getAlwaysTruePolicyId();
  const { scriptAddress } = loadValidator(myVkh, policyId);

  let tokenUtxo: UTxO | undefined;
  for (let i = 0; i < 60; i++) {
    const all = await provider().fetchAddressUTxOs(myAddr);
    tokenUtxo = all.find((u) => u.output.amount.some((a) => a.unit === unit));
    if (tokenUtxo) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!tokenUtxo) throw new Error("No UTxO with the minted asset");
  const tokenAmount = tokenUtxo.output.amount.find((a) => a.unit === unit)!.quantity;
  const allUtxos = await provider().fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, [{ unit, quantity: tokenAmount }])
    .txOutInlineDatumValue(mConStr0([]))
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
  console.log(`LOCK ok. amount=${tokenAmount} tx=${txHash}`);
  return scriptAddress;
}

async function unlock(wallet: MeshWallet, unit: string) {
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const policyId = getAlwaysTruePolicyId();
  const { script, scriptAddress } = loadValidator(myVkh, policyId);

  let utxo: UTxO | undefined;
  for (let i = 0; i < 60; i++) {
    const all = await provider().fetchAddressUTxOs(scriptAddress);
    utxo = all.find((u) => u.output.amount.some((a) => a.unit === unit));
    if (utxo) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!utxo) throw new Error("No script UTxO holding the asset");
  const tokenAmount = utxo.output.amount.find((a) => a.unit === unit)!.quantity;
  const ownUtxos = await provider().fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
    .txInScript(script)
    .txInRedeemerValue(mConStr0([]))
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
  console.log(`UNLOCK ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== token-transfer scenario: mint → lock → unlock ===");
  // Brewed wallet: starts pure-ADA. Pre-existing tokens here would land in change during unlock
  // and violate the validator (and break collateral); yaci-devkit also rejects multi-asset collateral.
  const wallet = makeWallet(MeshWallet.brew(false) as string[]);
  await fundFromFunder(await wallet.getChangeAddress(), 30_000_000n);

  const unit = getAlwaysTruePolicyId() + stringToHex(ASSET_NAME);
  await mint(wallet, unit);
  await new Promise((r) => setTimeout(r, 2000));
  await lock(wallet, unit);
  await new Promise((r) => setTimeout(r, 2000));
  await unlock(wallet, unit);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
