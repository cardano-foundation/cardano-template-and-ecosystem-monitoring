import {
  BlockfrostProvider,
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

// Atomic transaction: one PlutusV3 validator handling both mint and spend.
// Scenario: mintAndLock → collect (single tx that spends the locked UTxO AND mints) → burn.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const ASSET_NAME = "AtomicToken";
const PASSWORD = "super_secret_password";
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

function getScriptDetails() {
  const v = blueprint.validators.find((x) => x.title === "atomic.placeholder.mint");
  if (!v) throw new Error("Validator not found");
  const script = applyParamsToScript(v.compiledCode, [], "JSON");
  const { address } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, address, policyId: resolveScriptHash(script, "V3") };
}

async function mintAndLock(wallet: MeshWallet): Promise<string> {
  const { script, address: scriptAddress, policyId } = getScriptDetails();
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const unit = policyId + stringToHex(ASSET_NAME);
  const redeemer = mConStr0([stringToHex(PASSWORD)]);
  const utxos = await provider().fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .mintPlutusScriptV3()
    .mint("1", policyId, stringToHex(ASSET_NAME))
    // Inline minting script (vs. mintTxInReference): no reference UTxO infrastructure for this demo.
    .mintingScript(script)
    .mintRedeemerValue(redeemer)
    .txOut(scriptAddress, [{ unit, quantity: "1" }])
    .txOutInlineDatumValue(redeemer)
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
  console.log(`MINT+LOCK ok. tx=${txHash}`);
  return scriptAddress;
}

async function collect(wallet: MeshWallet, scriptAddress: string) {
  const { script, policyId } = getScriptDetails();
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const unit = policyId + stringToHex(ASSET_NAME);
  const redeemer = mConStr0([stringToHex(PASSWORD)]);

  let target: UTxO | undefined;
  for (let i = 0; i < 60; i++) {
    const utxos = await provider().fetchAddressUTxOs(scriptAddress);
    target = utxos.find((u) => u.output.amount.some((a) => a.unit === unit && a.quantity === "1"));
    if (target) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!target) throw new Error("No AtomicToken UTxO at script");
  const ownUtxos = await provider().fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();
  // Multiple Plutus scripts in one tx — default per-redeemer budget × N exceeds the tx limit,
  // so set conservative explicit exUnits per call.
  const exUnits = { mem: 4_000_000, steps: 2_000_000_000 };

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(target.input.txHash, target.input.outputIndex, target.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(redeemer, "Mesh", exUnits)
    .txInInlineDatumPresent()
    .mintPlutusScriptV3()
    .mint("1", policyId, stringToHex(ASSET_NAME))
    .mintingScript(script)
    .mintRedeemerValue(redeemer, "Mesh", exUnits)
    .txOut(myAddr, [{ unit, quantity: "2" }])
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
  console.log(`COLLECT (atomic spend+mint) ok. tx=${txHash}`);
}

async function burn(wallet: MeshWallet, amount: number) {
  const { script, policyId } = getScriptDetails();
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const redeemer = mConStr0([stringToHex(PASSWORD)]);
  const utxos = await provider().fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .mintPlutusScriptV3()
    .mint((-amount).toString(), policyId, stringToHex(ASSET_NAME))
    .mintingScript(script)
    .mintRedeemerValue(redeemer)
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
  console.log(`BURN ${amount} ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== atomic-transaction scenario: mint+lock → collect → burn ===");
  const wallet = makeWallet(MeshWallet.brew(false) as string[]);
  await fundFromFunder(await wallet.getChangeAddress(), 50_000_000n);

  const scriptAddress = await mintAndLock(wallet);
  await new Promise((r) => setTimeout(r, 2000));
  await collect(wallet, scriptAddress);
  await new Promise((r) => setTimeout(r, 2000));
  await burn(wallet, 2);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
