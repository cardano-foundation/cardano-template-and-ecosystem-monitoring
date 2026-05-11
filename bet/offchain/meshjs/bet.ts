import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  deserializeDatum,
  mConStr,
  mConStr0,
  resolvePaymentKeyHash,
  resolveScriptHash,
  serializeAddressObj,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Bet: one PlutusV3 script for mint (INIT) and spend (JOIN, ANNOUNCE).
// Three brewed actors satisfy on-chain `player2 != player1 and player2 != oracle`.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const ASSET_NAME = "LuckyNumberSlevin";
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

function funder(): MeshWallet {
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

async function yaciTipSlot(): Promise<number> {
  const block = await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json());
  return block.slot;
}

async function fundFromFunder(targetAddr: string, lovelace: bigint) {
  const wallet = funder();
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
  console.log(`Funded ${targetAddr} with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxoAt(targetAddr, 1);
}

function getScriptInfo() {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(compiled, [], "JSON");
  const policyId = resolveScriptHash(script, "V3");
  const { address: scriptAddress } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, policyId, scriptAddress };
}

async function init(
  player1: MeshWallet,
  oracle: MeshWallet,
  lovelace: string,
): Promise<{ txHash: string; expirationSlot: number; expirationMs: number }> {
  const { script, policyId, scriptAddress } = getScriptInfo();
  const player1Addr = await player1.getChangeAddress();
  const player1Vkh = resolvePaymentKeyHash(player1Addr);
  const oracleVkh = resolvePaymentKeyHash(await oracle.getChangeAddress());

  const tipSlot = await yaciTipSlot();
  const block = await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json());
  // TxInfo POSIX includes the 600s Babbage era-start offset above nominal systemStart;
  // the datum's expirationMs must match this so on-chain time math agrees with our slot math.
  const ERA_OFFSET_SECONDS = 600;
  const systemStartSec = block.time - block.slot + ERA_OFFSET_SECONDS;
  const validFromSlot = tipSlot - 5;
  const validToSlot = tipSlot + 60;
  const expirationSlot = validToSlot + 30;
  const expirationMs = (systemStartSec + expirationSlot) * 1000;

  const datum = mConStr0([player1Vkh, "", oracleVkh, expirationMs]);
  const utxos = await provider().fetchAddressUTxOs(player1Addr);
  const collateral: UTxO[] = await player1.getCollateral();

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({
    fetcher: provider(), submitter: provider(),
  }).setNetwork(NETWORK);
  await tx
    .mintPlutusScriptV3()
    .mint("1", policyId, stringToHex(ASSET_NAME))
    // Inline minting script (vs. mintTxInReference): no reference UTxO infrastructure in this demo.
    .mintingScript(script)
    .mintRedeemerValue(mConStr0([]))
    .txOut(scriptAddress, [
      { unit: "lovelace", quantity: lovelace },
      { unit: policyId + stringToHex(ASSET_NAME), quantity: "1" },
    ])
    .txOutInlineDatumValue(datum)
    .txInCollateral(
      collateral[0].input.txHash, collateral[0].input.outputIndex,
      collateral[0].output.amount, collateral[0].output.address,
    )
    .requiredSignerHash(player1Vkh)
    .invalidBefore(validFromSlot)
    .invalidHereafter(validToSlot)
    .changeAddress(player1Addr)
    .selectUtxosFrom(utxos)
    .complete();

  const signed = await player1.signTx(tx.txHex);
  const txHash = await player1.submitTx(signed);
  console.log(`INIT ok. tx=${txHash} expirationSlot=${expirationSlot}`);
  return { txHash, expirationSlot, expirationMs };
}

async function join(player2: MeshWallet, initTxHash: string, expirationSlot: number) {
  const { script, policyId, scriptAddress } = getScriptInfo();
  const player2Addr = await player2.getChangeAddress();
  const player2Vkh = resolvePaymentKeyHash(player2Addr);

  const utxo = await waitForTx(initTxHash, 0);
  if (!utxo.output.plutusData) throw new Error("No inline datum");
  const decoded = deserializeDatum(utxo.output.plutusData) as {
    fields: Array<{ bytes?: string; int?: bigint }>;
  };
  const p1 = decoded.fields[0].bytes ?? "";
  const oVkh = decoded.fields[2].bytes ?? "";
  const expiration = Number(decoded.fields[3].int ?? 0);
  const newDatum = mConStr0([p1, player2Vkh, oVkh, expiration]);

  const lovelaceIn = utxo.output.amount.find((a) => a.unit === "lovelace")!.quantity;
  const newLovelace = (BigInt(lovelaceIn) * 2n).toString();

  const ownUtxos = await provider().fetchAddressUTxOs(player2Addr);
  const collateral: UTxO[] = await player2.getCollateral();
  const tx = new MeshTxBuilder({
    fetcher: provider(), submitter: provider(),
  }).setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
    .txInScript(script)
    .txInRedeemerValue(mConStr0([]))
    .txInInlineDatumPresent()
    .txOut(scriptAddress, [
      { unit: "lovelace", quantity: newLovelace },
      { unit: policyId + stringToHex(ASSET_NAME), quantity: "1" },
    ])
    .txOutInlineDatumValue(newDatum)
    .txInCollateral(
      collateral[0].input.txHash, collateral[0].input.outputIndex,
      collateral[0].output.amount, collateral[0].output.address,
    )
    .requiredSignerHash(player2Vkh)
    .invalidBefore((await yaciTipSlot()) - 5)
    .invalidHereafter(expirationSlot - 5)
    .changeAddress(player2Addr)
    .selectUtxosFrom(ownUtxos)
    .complete();

  const signed = await player2.signTx(tx.txHex);
  const txHash = await player2.submitTx(signed);
  console.log(`JOIN ok. tx=${txHash}`);
  return txHash;
}

async function announce(oracle: MeshWallet, joinTxHash: string) {
  const { script } = getScriptInfo();
  const oracleAddr = await oracle.getChangeAddress();
  const oracleVkh = resolvePaymentKeyHash(oracleAddr);

  const utxo = await waitForTx(joinTxHash, 0);
  if (!utxo.output.plutusData) throw new Error("No inline datum");
  const decoded = deserializeDatum(utxo.output.plutusData) as {
    fields: Array<{ bytes?: string; int?: bigint }>;
  };
  const p1 = decoded.fields[0].bytes ?? "";
  const p2 = decoded.fields[1].bytes ?? "";
  const expirationMs = Number(decoded.fields[3].int ?? 0);
  if (!p2) throw new Error("player2 still empty");

  const block = await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json());
  const ERA_OFFSET_SECONDS = 600;
  const systemStartSec = block.time - block.slot + ERA_OFFSET_SECONDS;
  const expirationSlot = Math.floor(expirationMs / 1000) - systemStartSec;

  const winnerVkh = p1;
  // mPubKeyAddress returns Mesh-shape {alternative,fields}; serializeAddressObj wants JSON-shape
  // {constructor,fields}. Enterprise address: payment cred + no stake (None).
  const winnerAddrJson = {
    constructor: 0,
    fields: [
      { constructor: 0, fields: [{ bytes: winnerVkh }] },
      { constructor: 1, fields: [] },
    ],
  };
  const winnerEnt = serializeAddressObj(winnerAddrJson as never, NETWORK_ID);
  const redeemer = mConStr(1, [winnerVkh]);

  const ownUtxos = await provider().fetchAddressUTxOs(oracleAddr);
  const collateral: UTxO[] = await oracle.getCollateral();
  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({
    fetcher: provider(), submitter: provider(),
  }).setNetwork(NETWORK);
  // Validator requires exactly one output; we omit an explicit script-value txOut and let
  // changeAddress consolidate (script value + oracle input − fee) into a single winner output.
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
    .txInScript(script)
    .txInRedeemerValue(redeemer)
    .txInInlineDatumPresent()
    .txInCollateral(
      collateral[0].input.txHash, collateral[0].input.outputIndex,
      collateral[0].output.amount, collateral[0].output.address,
    )
    .requiredSignerHash(oracleVkh)
    // Validator demands valid_after(expiration) — invalidBefore must be strictly past expirationSlot.
    .invalidBefore(Math.max(await yaciTipSlot(), expirationSlot + 1))
    .invalidHereafter(Math.max(await yaciTipSlot(), expirationSlot + 1) + 120)
    .changeAddress(winnerEnt)
    .selectUtxosFrom(ownUtxos)
    .complete();

  const signed = await oracle.signTx(tx.txHex);
  const txHash = await oracle.submitTx(signed);
  console.log(`ANNOUNCE ok. winner=${winnerEnt}. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== bet scenario: init → join → announce ===");

  // Roles: player1 stakes & locks, player2 matches, oracle announces. Brewed so each is distinct
  // (on-chain check requires three different pkhs) and collateral is naturally pure-ADA on yaci.
  const player1 = makeWallet(MeshWallet.brew(false) as string[]);
  const player2 = makeWallet(MeshWallet.brew(false) as string[]);
  const oracle  = makeWallet(MeshWallet.brew(false) as string[]);

  await fundFromFunder(await player1.getChangeAddress(), 30_000_000n);
  await fundFromFunder(await player2.getChangeAddress(), 30_000_000n);
  await fundFromFunder(await oracle.getChangeAddress(), 10_000_000n);

  const { txHash: initTxHash, expirationSlot } = await init(player1, oracle, "10000000");
  const joinTxHash = await join(player2, initTxHash, expirationSlot);

  for (let i = 0; i < 300; i++) {
    const tipSlot = await yaciTipSlot();
    if (tipSlot > expirationSlot) {
      console.log(`tipSlot ${tipSlot} > expirationSlot ${expirationSlot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tipSlot} → ${expirationSlot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await announce(oracle, joinTxHash);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
