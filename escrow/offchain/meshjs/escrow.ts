import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  conStr0,
  conStr1,
  deserializeAddress,
  deserializeDatum,
  mConStr,
  pubKeyAddress,
  resolvePaymentKeyHash,
  serializeAddressObj,
  serializePlutusScript,
  value,
  type Asset,
  type ConStr0,
  type ConStr1,
  type PubKeyAddress,
  type UTxO,
  type Value,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// Escrow: two-party trade — Initiation → ActiveEscrow → CompleteTrade, plus a Cancel path.
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

async function fundFromFunder(targets: Array<{ addr: string; lovelace: bigint }>) {
  const wallet = funderWallet();
  const myAddr = await wallet.getChangeAddress();
  const myUtxos = await provider().fetchAddressUTxOs(myAddr);
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let b = tx as unknown as MeshTxBuilder;
  for (const t of targets) {
    b = b.txOut(t.addr, [{ unit: "lovelace", quantity: t.lovelace.toString() }]);
  }
  await b.changeAddress(myAddr).selectUtxosFrom(myUtxos).complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Funded ${targets.length} target(s). tx=${txHash}`);
  for (const t of targets) await waitForUtxoAt(t.addr, 1);
}

function getScriptInfo() {
  const compiled = applyParamsToScript(blueprint.validators[0].compiledCode, [], "JSON");
  const { address } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script: compiled, scriptAddress: address };
}

type InitiationDatum = ConStr0<[PubKeyAddress, Value]>;
type ActiveEscrowDatum = ConStr1<[PubKeyAddress, Value, PubKeyAddress, Value]>;

function buildInitiationDatum(walletAddress: string, amount: Asset[]): InitiationDatum {
  const { pubKeyHash, stakeCredentialHash } = deserializeAddress(walletAddress);
  return conStr0([pubKeyAddress(pubKeyHash, stakeCredentialHash), value(amount)]);
}
function buildActiveEscrowDatum(
  init: InitiationDatum,
  recipientAddr: string,
  recipientAmount: Asset[],
): ActiveEscrowDatum {
  const { pubKeyHash, stakeCredentialHash } = deserializeAddress(recipientAddr);
  const [initiator, initiatorAmount] = init.fields;
  return conStr1([
    initiator,
    initiatorAmount,
    pubKeyAddress(pubKeyHash, stakeCredentialHash),
    value(recipientAmount),
  ]);
}

function mergeAssetsLocal(a: Asset[], b: Asset[]): Asset[] {
  const map = new Map<string, bigint>();
  for (const x of [...a, ...b]) {
    map.set(x.unit, (map.get(x.unit) ?? 0n) + BigInt(x.quantity));
  }
  return [...map].map(([unit, q]) => ({ unit, quantity: q.toString() }));
}

async function initiate(initiator: MeshWallet, escrowAmount: Asset[]): Promise<string> {
  const myAddr = await initiator.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const { scriptAddress } = getScriptInfo();
  const datum = buildInitiationDatum(myAddr, escrowAmount);
  const utxos = await provider().fetchAddressUTxOs(myAddr);

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, escrowAmount)
    // JSON-shape datum: conStr0 / pubKeyAddress / value all emit {constructor,fields} —
    // mesh-shape {alternative,fields} would be rejected by the "JSON" encoder.
    .txOutInlineDatumValue(datum, "JSON")
    .requiredSignerHash(myVkh)
    .changeAddress(myAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await initiator.signTx(tx.txHex);
  const txHash = await initiator.submitTx(signed);
  console.log(`INITIATE ok. tx=${txHash}`);
  return txHash;
}

async function deposit(
  recipient: MeshWallet,
  initTxHash: string,
  recipientAmount: Asset[],
): Promise<string> {
  const recipAddr = await recipient.getChangeAddress();
  const recipVkh = resolvePaymentKeyHash(recipAddr);
  const { script, scriptAddress } = getScriptInfo();
  const utxo = await waitForTx(initTxHash, 0);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const inputDatum = deserializeDatum<InitiationDatum>(utxo.output.plutusData);
  const outputDatum = buildActiveEscrowDatum(inputDatum, recipAddr, recipientAmount);
  // pubKeyAddress / value emit JSON-shape {constructor,fields}, so the whole redeemer must
  // be passed as "JSON" — mixing Mesh-shape here would corrupt the encoded redeemer.
  const redeemer = conStr0([
    pubKeyAddress(recipVkh, deserializeAddress(recipAddr).stakeCredentialHash),
    value(recipientAmount),
  ]);
  const totalValue = mergeAssetsLocal(utxo.output.amount, recipientAmount);
  const ownUtxos = await provider().fetchAddressUTxOs(recipAddr);
  const collateral: UTxO[] = await recipient.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    // Multiple Plutus scripts in one tx — default per-redeemer budget × N exceeds the tx limit,
    // so set conservative explicit exUnits per call.
    .txInRedeemerValue(redeemer, "JSON", { mem: 7_000_000, steps: 3_000_000_000 })
    .txInInlineDatumPresent()
    .txOut(scriptAddress, totalValue)
    .txOutInlineDatumValue(outputDatum, "JSON")
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(recipVkh)
    .changeAddress(recipAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await recipient.signTx(tx.txHex);
  const txHash = await recipient.submitTx(signed);
  console.log(`DEPOSIT ok. tx=${txHash}`);
  return txHash;
}

async function completeTrade(
  initiator: MeshWallet,
  recipient: MeshWallet,
  activeTx: string,
) {
  const initAddr = await initiator.getChangeAddress();
  const recipAddr = await recipient.getChangeAddress();
  const initVkh = resolvePaymentKeyHash(initAddr);
  const recipVkh = resolvePaymentKeyHash(recipAddr);
  const { script, scriptAddress } = getScriptInfo();
  const utxo = await waitForTx(activeTx, 0);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const datum = deserializeDatum<ActiveEscrowDatum>(utxo.output.plutusData);
  const initiatorAmountField = datum.fields[1] as Value;
  const recipientAmountField = datum.fields[3] as Value;
  type MapEntry = { k: { bytes: string }; v: { int?: string | number | bigint; map?: MapEntry[] } };
  const toAssets = (v: unknown): Asset[] => {
    const outer = (v as { map?: MapEntry[] }).map ?? [];
    const out: Asset[] = [];
    for (const e of outer) {
      const pol = e.k.bytes;
      const tokens = e.v.map ?? [];
      for (const t of tokens) {
        const name = t.k.bytes;
        const qty = BigInt(t.v.int ?? 0).toString();
        const unit = pol === "" ? "lovelace" : pol + name;
        out.push({ unit, quantity: qty });
      }
    }
    return out;
  };
  const initiatorAssets = toAssets(initiatorAmountField);
  const recipientAssets = toAssets(recipientAmountField);

  const ownUtxos = await provider().fetchAddressUTxOs(initAddr);
  const collateral: UTxO[] = await initiator.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    // Explicit exUnits: complete-trade is the heaviest redeemer; let mesh fee estimate stay sane.
    .txInRedeemerValue(mConStr(2, []), "Mesh", { mem: 7_000_000, steps: 3_000_000_000 })
    .txInInlineDatumPresent()
    .txOut(initAddr, recipientAssets)
    .txOut(recipAddr, initiatorAssets)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(initVkh)
    .requiredSignerHash(recipVkh)
    .changeAddress(initAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  let signed = await initiator.signTx(tx.txHex, true);
  signed = await recipient.signTx(signed, true);
  const txHash = await initiator.submitTx(signed);
  console.log(`COMPLETE ok. tx=${txHash}`);
}

async function cancelInInitiation(initiator: MeshWallet, initTxHash: string) {
  const initAddr = await initiator.getChangeAddress();
  const initVkh = resolvePaymentKeyHash(initAddr);
  const { script, scriptAddress } = getScriptInfo();
  const utxo = await waitForTx(initTxHash, 0);
  const ownUtxos = await provider().fetchAddressUTxOs(initAddr);
  const collateral: UTxO[] = await initiator.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr(1, []), "Mesh", { mem: 7_000_000, steps: 3_000_000_000 })
    .txInInlineDatumPresent()
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(initVkh)
    .changeAddress(initAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await initiator.signTx(tx.txHex);
  const txHash = await initiator.submitTx(signed);
  console.log(`CANCEL (initiation) ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== escrow scenario: initiate → deposit → complete ; initiate → cancel ===");
  // Roles: initiator locks first leg, recipient deposits second leg, both co-sign completion.
  const initiator = makeWallet(MeshWallet.brew(false) as string[]);
  const recipient = makeWallet(MeshWallet.brew(false) as string[]);
  const initAddr = await initiator.getChangeAddress();
  const recipAddr = await recipient.getChangeAddress();
  await fundFromFunder([
    { addr: initAddr, lovelace: 30_000_000n },
    { addr: recipAddr, lovelace: 30_000_000n },
  ]);

  const initiatorAssets: Asset[] = [{ unit: "lovelace", quantity: "5000000" }];
  const recipientAssets: Asset[] = [{ unit: "lovelace", quantity: "7000000" }];

  const initTx = await initiate(initiator, initiatorAssets);
  await new Promise((r) => setTimeout(r, 2000));
  const activeTx = await deposit(recipient, initTx, recipientAssets);
  await new Promise((r) => setTimeout(r, 2000));
  await completeTrade(initiator, recipient, activeTx);
  await new Promise((r) => setTimeout(r, 2000));

  const initTx2 = await initiate(initiator, [{ unit: "lovelace", quantity: "4000000" }]);
  await new Promise((r) => setTimeout(r, 2000));
  await cancelInInitiation(initiator, initTx2);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
