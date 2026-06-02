import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  deserializeDatum,
  mConStr,
  mConStr0,
  mConStr1,
  mConStr2,
  resolvePaymentKeyHash,
  resolveScriptHash,
  serializeAddressObj,
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

// Pricebet: validator referencing an oracle UTxO at an always-true PlutusV3 address.
// Scenario: setup-oracle → create → join → win ; second flow: create → wait → timeout.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
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
  const compiled = applyParamsToScript(blueprint.validators[0].compiledCode, [], "JSON");
  const { address: scriptAddress } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script: compiled, scriptAddress };
}

function getOracleScript() {
  const policyId = resolveScriptHash(ALWAYS_TRUE_SCRIPT_CBOR, "V3");
  const { address } = serializePlutusScript(
    { code: ALWAYS_TRUE_SCRIPT_CBOR, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { policyId, address };
}

function vkhToEnterpriseAddr(vkh: string): string {
  // Validator requires the winner/owner payout to go to an enterprise address (no stake part).
  // mPubKeyAddress returns Mesh-shape {alternative,fields}; serializeAddressObj wants JSON-shape.
  return serializeAddressObj({
    constructor: 0,
    fields: [
      { constructor: 0, fields: [{ bytes: vkh }] },
      { constructor: 1, fields: [] },
    ],
  } as never, NETWORK_ID);
}

function buildOracleDatum(price: number, ts: number, expiry: number): unknown {
  return {
    constructor: 0,
    fields: [
      {
        constructor: 2,
        fields: [{
          map: [
            { k: { int: 0 }, v: { int: price } },
            { k: { int: 1 }, v: { int: ts } },
            { k: { int: 2 }, v: { int: expiry } },
          ],
        }],
      },
    ],
  };
}

interface PriceBetDatum {
  owner: string;
  player: string | null;
  oracleVkh: string;
  targetRate: number;
  deadline: number;
  betAmount: number;
}
function encodeDatum(d: PriceBetDatum): unknown {
  const playerOption = d.player === null ? mConStr1([]) : mConStr0([d.player]);
  return mConStr0([d.owner, playerOption, d.oracleVkh, d.targetRate, d.deadline, d.betAmount]);
}
function decodeDatum(plutusHex: string): PriceBetDatum {
  const d = deserializeDatum(plutusHex) as {
    fields: Array<{
      bytes?: string;
      int?: string | number | bigint;
      fields?: Array<{ bytes?: string }>;
      constructor?: number;
      alternative?: number;
    }>;
  };
  const f = d.fields;
  const playerField = f[1];
  const ctorIdx = playerField.constructor ?? playerField.alternative ?? 0;
  const player = ctorIdx === 0 && playerField.fields && playerField.fields[0]
    ? (playerField.fields[0].bytes ?? null)
    : null;
  return {
    owner: f[0].bytes ?? "",
    player,
    oracleVkh: f[2].bytes ?? "",
    targetRate: Number(f[3].int ?? 0),
    deadline: Number(f[4].int ?? 0),
    betAmount: Number(f[5].int ?? 0),
  };
}

async function setupOracle(wallet: MeshWallet, price: number, validForMs: number): Promise<{
  oracleScriptHash: string;
  oracleAddress: string;
  oracleUtxo: UTxO;
}> {
  const oracle = getOracleScript();
  const datum = buildOracleDatum(price, Date.now(), Date.now() + validForMs);
  const ownAddr = await wallet.getChangeAddress();
  const utxos = await provider().fetchAddressUTxOs(ownAddr);

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(oracle.address, [{ unit: "lovelace", quantity: "2000000" }])
    // JSON-shape oracle datum (constructor/fields). Mesh-shape would be rejected by "JSON" encoder.
    .txOutInlineDatumValue(datum, "JSON")
    .changeAddress(ownAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`SETUP_ORACLE ok. tx=${txHash}`);

  const oracleUtxo = await waitForTx(txHash, 0);
  return { oracleScriptHash: oracle.policyId, oracleAddress: oracle.address, oracleUtxo };
}

async function createBet(
  owner: MeshWallet,
  oracleScriptHash: string,
  targetRate: number,
  deadlineMs: number,
  betAmount: number,
): Promise<string> {
  const ownerAddr = await owner.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const { scriptAddress } = getScriptInfo();
  const datum: PriceBetDatum = {
    owner: ownerVkh, player: null, oracleVkh: oracleScriptHash,
    targetRate, deadline: deadlineMs, betAmount,
  };
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: betAmount.toString() }])
    .txOutInlineDatumValue(encodeDatum(datum))
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`CREATE ok. tx=${txHash}`);
  return txHash;
}

async function joinBet(player: MeshWallet, createTxHash: string): Promise<string> {
  const playerAddr = await player.getChangeAddress();
  const playerVkh = resolvePaymentKeyHash(playerAddr);
  const { script, scriptAddress } = getScriptInfo();
  const utxo = await waitForTx(createTxHash, 0);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const current = decodeDatum(utxo.output.plutusData);
  const updated: PriceBetDatum = { ...current, player: playerVkh };
  const totalPot = current.betAmount * 2;

  const systemStartSec = await yaciSystemStartSec();
  const deadlineSlot = Math.floor(current.deadline / 1000) - systemStartSec;
  const tipSlot = await yaciTipSlot();
  const validToSlot = Math.min(tipSlot + 10, deadlineSlot - 1);

  const ownUtxos = await provider().fetchAddressUTxOs(playerAddr);
  const collateral: UTxO[] = await player.getCollateral();
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr0([]))
    .txInInlineDatumPresent()
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: totalPot.toString() }])
    .txOutInlineDatumValue(encodeDatum(updated))
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(playerVkh)
    .invalidBefore(tipSlot - 5)
    .invalidHereafter(validToSlot)
    .changeAddress(playerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await player.signTx(tx.txHex);
  const txHash = await player.submitTx(signed);
  console.log(`JOIN ok. tx=${txHash}`);
  return txHash;
}

async function winBet(
  player: MeshWallet,
  joinTxHash: string,
  oracleUtxo: UTxO,
): Promise<string> {
  const playerAddr = await player.getChangeAddress();
  const playerVkh = resolvePaymentKeyHash(playerAddr);
  const playerEnt = vkhToEnterpriseAddr(playerVkh);
  const { script, scriptAddress } = getScriptInfo();
  const utxo = await waitForTx(joinTxHash, 0);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const current = decodeDatum(utxo.output.plutusData);
  const totalPot = BigInt(utxo.output.amount.find((a) => a.unit === "lovelace")!.quantity);

  const systemStartSec = await yaciSystemStartSec();
  const deadlineSlot = Math.floor(current.deadline / 1000) - systemStartSec;
  const tipSlot = await yaciTipSlot();
  const validToSlot = Math.min(tipSlot + 10, deadlineSlot - 1);

  const ownUtxos = await provider().fetchAddressUTxOs(playerAddr);
  const collateral: UTxO[] = await player.getCollateral();
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr1([]))
    .txInInlineDatumPresent()
    .readOnlyTxInReference(oracleUtxo.input.txHash, oracleUtxo.input.outputIndex)
    .txOut(playerEnt, [{ unit: "lovelace", quantity: totalPot.toString() }])
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(playerVkh)
    // Win must happen BEFORE deadline → invalidHereafter strictly less than deadline slot.
    .invalidBefore(tipSlot - 5)
    .invalidHereafter(validToSlot)
    .changeAddress(playerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await player.signTx(tx.txHex);
  const txHash = await player.submitTx(signed);
  console.log(`WIN ok. tx=${txHash}`);
  return txHash;
}

async function timeoutBet(owner: MeshWallet, createTxHash: string): Promise<string> {
  const ownerAddr = await owner.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const ownerEnt = vkhToEnterpriseAddr(ownerVkh);
  const { script, scriptAddress } = getScriptInfo();
  const utxo = await waitForTx(createTxHash, 0);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const current = decodeDatum(utxo.output.plutusData);
  const totalPot = BigInt(utxo.output.amount.find((a) => a.unit === "lovelace")!.quantity);

  const systemStartSec = await yaciSystemStartSec();
  const deadlineSlot = Math.floor(current.deadline / 1000) - systemStartSec;
  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > deadlineSlot) {
      console.log(`tipSlot ${tip} > deadlineSlot ${deadlineSlot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${deadlineSlot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tipSlot = await yaciTipSlot();
  // Timeout requires `valid_after deadline` — invalidBefore must be strictly past deadlineSlot.
  const validFromSlot = Math.max(deadlineSlot + 1, tipSlot - 5);

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
    .txOut(ownerEnt, [{ unit: "lovelace", quantity: totalPot.toString() }])
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
  console.log(`TIMEOUT ok. tx=${txHash}`);
  return txHash;
}

async function runScenario() {
  console.log("=== pricebet scenario: setup-oracle → create → join → win ; create → timeout ===");
  // Roles: owner publishes oracle + creates bets (and reclaims on timeout); player joins and wins.
  const owner = makeWallet(MeshWallet.brew(false) as string[]);
  const player = makeWallet(MeshWallet.brew(false) as string[]);
  await fundFromFunder(await owner.getChangeAddress(), 50_000_000n);
  await fundFromFunder(await player.getChangeAddress(), 30_000_000n);

  const { oracleScriptHash, oracleUtxo } = await setupOracle(owner, 100, 24 * 60 * 60 * 1000);
  await new Promise((r) => setTimeout(r, 2000));

  const systemStartSec = await yaciSystemStartSec();
  const tipSlot1 = await yaciTipSlot();
  const deadline1Ms = slotToMs(tipSlot1 + 90, systemStartSec);
  const createTx1 = await createBet(owner, oracleScriptHash, 50, deadline1Ms, 5_000_000);
  await new Promise((r) => setTimeout(r, 2000));
  const joinTx = await joinBet(player, createTx1);
  await new Promise((r) => setTimeout(r, 2000));
  await winBet(player, joinTx, oracleUtxo);
  await new Promise((r) => setTimeout(r, 2000));

  const tipSlot2 = await yaciTipSlot();
  const deadline2Ms = slotToMs(tipSlot2 + 15, systemStartSec);
  const createTx2 = await createBet(owner, oracleScriptHash, 50, deadline2Ms, 5_000_000);
  await new Promise((r) => setTimeout(r, 2000));
  await timeoutBet(owner, createTx2);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
