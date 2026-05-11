import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  deserializeDatum,
  mConStr,
  mConStr0,
  resolvePaymentKeyHash,
  serializePlutusScript,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Decentralized identity: one spending validator over a (owner, [delegates]) state.
// Scenario: init → add-delegate → remove-delegate → transfer-owner.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
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

async function waitForTx(txHash: string, outputIndex = 0, timeoutSec = 60): Promise<UTxO> {
  const p = provider();
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const utxos = await p.fetchUTxOs(txHash);
      const u = utxos.find((x) => x.input.outputIndex === outputIndex);
      if (u) return u;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${txHash}#${outputIndex}`);
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

function getScriptInfo() {
  const v = blueprint.validators.find((x) => x.title === "identity.identity.spend");
  if (!v) throw new Error("Validator not found");
  const compiled = applyParamsToScript(v.compiledCode, [], "JSON");
  const { address: scriptAddress } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script: compiled, scriptAddress };
}

interface DelegateEntry { key: string; expires: number }
interface IdentityState { owner: string; delegates: DelegateEntry[] }

function decodeDatum(datumHex: string): IdentityState {
  const d = deserializeDatum(datumHex) as {
    fields: Array<
      | { bytes?: string }
      | { list?: Array<{ fields: Array<{ bytes?: string; int?: string | number | bigint }> }> }
    >;
  };
  const owner = (d.fields[0] as { bytes: string }).bytes;
  const list = (d.fields[1] as { list?: Array<{ fields: Array<{ bytes?: string; int?: string | number | bigint }> }> }).list ?? [];
  return {
    owner,
    delegates: list.map((e) => ({
      key: e.fields[0].bytes ?? "",
      expires: Number(e.fields[1].int ?? 0),
    })),
  };
}
function encodeDatum(state: IdentityState): unknown {
  const delegateList = state.delegates.map((d) => mConStr0([d.key, d.expires]));
  return mConStr0([state.owner, delegateList]);
}

async function init(owner: MeshWallet, lovelace: bigint): Promise<string> {
  const ownerAddr = await owner.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const { scriptAddress } = getScriptInfo();
  const datum = encodeDatum({ owner: ownerVkh, delegates: [] });
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);
  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: lovelace.toString() }])
    .txOutInlineDatumValue(datum)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`INIT ok. tx=${txHash}`);
  return txHash;
}

async function performAction(
  owner: MeshWallet,
  prevTxHash: string,
  redeemer: unknown,
  updateState: (state: IdentityState) => IdentityState,
  options: { expiresMs?: number } = {},
): Promise<string> {
  const ownerAddr = await owner.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const { script, scriptAddress } = getScriptInfo();
  const utxo = await waitForTx(prevTxHash, 0);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const state = decodeDatum(utxo.output.plutusData);
  const updated = updateState(state);

  const ownUtxos = await provider().fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await owner.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let b = tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(redeemer)
    .txInInlineDatumPresent()
    .txOut(scriptAddress, utxo.output.amount.map((a) => ({ unit: a.unit, quantity: a.quantity })))
    .txOutInlineDatumValue(encodeDatum(updated))
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh);
  if (options.expiresMs !== undefined) {
    const systemStartSec = await yaciSystemStartSec();
    const expiresSlot = Math.floor(options.expiresMs / 1000) - systemStartSec;
    const tipSlot = await yaciTipSlot();
    const validToSlot = Math.min(tipSlot + 10, expiresSlot - 5);
    b = b.invalidBefore(tipSlot - 5).invalidHereafter(validToSlot);
  }
  await b
    .changeAddress(ownerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  return txHash;
}

async function runScenario() {
  console.log("=== did scenario: init → add-delegate → remove-delegate → transfer-owner ===");
  // Roles: owner controls + signs all updates, delegate is added/removed, newOwner receives the DID.
  const owner = makeWallet(MeshWallet.brew(false) as string[]);
  const delegate = makeWallet(MeshWallet.brew(false) as string[]);
  const newOwner = makeWallet(MeshWallet.brew(false) as string[]);
  await fundFromFunder(await owner.getChangeAddress(), 30_000_000n);
  const delegateVkh = resolvePaymentKeyHash(await delegate.getChangeAddress());
  const newOwnerVkh = resolvePaymentKeyHash(await newOwner.getChangeAddress());

  const initTx = await init(owner, 3_000_000n);
  await new Promise((r) => setTimeout(r, 2000));

  const expiresMs = Date.now() + 24 * 60 * 60 * 1000;
  const addTx = await performAction(
    owner,
    initTx,
    mConStr(1, [delegateVkh, expiresMs]),
    (s) => ({ owner: s.owner, delegates: [...s.delegates, { key: delegateVkh, expires: expiresMs }] }),
    { expiresMs },
  );
  console.log(`ADD_DELEGATE ok. tx=${addTx}`);
  await new Promise((r) => setTimeout(r, 2000));

  const remTx = await performAction(
    owner,
    addTx,
    mConStr(2, [delegateVkh]),
    (s) => ({ owner: s.owner, delegates: s.delegates.filter((d) => d.key !== delegateVkh) }),
  );
  console.log(`REMOVE_DELEGATE ok. tx=${remTx}`);
  await new Promise((r) => setTimeout(r, 2000));

  const transferTx = await performAction(
    owner,
    remTx,
    mConStr(0, [newOwnerVkh]),
    (s) => ({ owner: newOwnerVkh, delegates: s.delegates }),
  );
  console.log(`TRANSFER_OWNER ok. tx=${transferTx}`);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
