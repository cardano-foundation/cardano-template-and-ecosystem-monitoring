import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  deserializeDatum,
  integer,
  mConStr0,
  mConStr1,
  mConStr2,
  resolvePaymentKeyHash,
  serializePlutusScript,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// Vault: parameterized validator (owner_vkh, wait_time_ms) with WITHDRAW/FINALIZE/CANCEL paths.
// Scenario: lock×2 → withdraw → cancel ; second lock: withdraw → wait → finalize.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const WAIT_TIME_MS = 10_000;
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

async function yaciTipSlot(): Promise<number> {
  return (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot;
}
async function yaciSystemStartSec(): Promise<number> {
  const block = await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json());
  return block.time - block.slot + 600;
}
function slotToMs(slot: number, systemStartSec: number): number {
  return (systemStartSec + slot) * 1000;
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

async function findScriptUtxo(scriptAddr: string, initTxHash: string): Promise<UTxO> {
  for (let i = 0; i < 60; i++) {
    const utxos = await provider().fetchAddressUTxOs(scriptAddr);
    const u = utxos.find((x) => x.input.txHash === initTxHash);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`UTxO ${initTxHash} not found at ${scriptAddr}`);
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

function loadScript(ownerVkh: string) {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(
    compiled,
    [builtinByteString(ownerVkh), integer(WAIT_TIME_MS)],
    "JSON",
  );
  const { address: scriptAddress } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, scriptAddress };
}

async function lock(owner: MeshWallet, ownerVkh: string, amount: bigint, infinite: boolean): Promise<string> {
  const ownerAddr = await owner.getChangeAddress();
  const { scriptAddress } = loadScript(ownerVkh);
  const lockTimeMs = infinite ? Date.now() + 365 * 24 * 60 * 60 * 1000 : Date.now() - 60_000;
  const datum = mConStr0([lockTimeMs]);
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);
  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: amount.toString() }])
    .txOutInlineDatumValue(datum)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`LOCK${infinite ? " (infinite)" : " (withdrawable)"} ok. tx=${txHash}`);
  return txHash;
}

async function withdraw(owner: MeshWallet, ownerVkh: string, initTx: string): Promise<string> {
  const ownerAddr = await owner.getChangeAddress();
  const { script, scriptAddress } = loadScript(ownerVkh);
  const utxo = await findScriptUtxo(scriptAddress, initTx);

  const systemStartSec = await yaciSystemStartSec();
  const tipSlot = await yaciTipSlot();
  const validFromSlot = tipSlot - 5;
  const lockTimeMs = slotToMs(validFromSlot - 5, systemStartSec);
  const newDatum = mConStr0([lockTimeMs]);
  const lovelaceAmount = utxo.output.amount.find((a) => a.unit === "lovelace")!.quantity;
  const ownUtxos = await provider().fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await owner.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr0([]))
    .txInInlineDatumPresent()
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: lovelaceAmount }])
    .txOutInlineDatumValue(newDatum)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .invalidBefore(validFromSlot)
    .invalidHereafter(tipSlot + 60)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`WITHDRAW ok. new lockTime=${lockTimeMs} tx=${txHash}`);
  return txHash;
}

async function finalize(owner: MeshWallet, ownerVkh: string, withdrawTx: string): Promise<string> {
  const ownerAddr = await owner.getChangeAddress();
  const { script, scriptAddress } = loadScript(ownerVkh);
  const utxo = await findScriptUtxo(scriptAddress, withdrawTx);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const datum = deserializeDatum(utxo.output.plutusData);
  const lockTimeMs = Number(datum.fields[0].int);
  const validAfterMs = lockTimeMs + WAIT_TIME_MS;

  const systemStartSec = await yaciSystemStartSec();
  const validAfterSlot = Math.floor(validAfterMs / 1000) - systemStartSec;
  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > validAfterSlot) break;
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${validAfterSlot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tipSlot = await yaciTipSlot();
  // FINALIZE requires `valid_after (lockTime + wait)` — invalidBefore must be strictly past it.
  const validFromSlot = Math.max(validAfterSlot + 1, tipSlot - 5);

  const ownUtxos = await provider().fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await owner.getCollateral();
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr1([]))
    .txInInlineDatumPresent()
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .invalidBefore(validFromSlot)
    .invalidHereafter(validFromSlot + 60)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`FINALIZE ok. tx=${txHash}`);
  return txHash;
}

async function cancel(owner: MeshWallet, ownerVkh: string, withdrawTx: string): Promise<string> {
  const ownerAddr = await owner.getChangeAddress();
  const { script, scriptAddress } = loadScript(ownerVkh);
  const utxo = await findScriptUtxo(scriptAddress, withdrawTx);
  const lovelaceAmount = utxo.output.amount.find((a) => a.unit === "lovelace")!.quantity;
  const ownUtxos = await provider().fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await owner.getCollateral();
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr2([]))
    .txInInlineDatumPresent()
    // CANCEL rule: continuing output must have NO datum (reverts to "infinitely locked" state).
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: lovelaceAmount }])
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`CANCEL ok. tx=${txHash}`);
  return txHash;
}

async function runScenario() {
  console.log("=== vault scenario: lock×2 → withdraw → cancel ; withdraw → finalize ===");
  const owner = makeWallet(MeshWallet.brew(false) as string[]);
  const ownerAddr = await owner.getChangeAddress();
  await fundFromFunder(ownerAddr, 50_000_000n);
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);

  const txA = await lock(owner, ownerVkh, 8_000_000n, true);
  await new Promise((r) => setTimeout(r, 2000));
  const txB = await lock(owner, ownerVkh, 6_000_000n, true);
  await new Promise((r) => setTimeout(r, 2000));

  const txA2 = await withdraw(owner, ownerVkh, txA);
  await new Promise((r) => setTimeout(r, 2000));
  await cancel(owner, ownerVkh, txA2);
  await new Promise((r) => setTimeout(r, 2000));

  const txB2 = await withdraw(owner, ownerVkh, txB);
  await new Promise((r) => setTimeout(r, 2000));
  await finalize(owner, ownerVkh, txB2);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
