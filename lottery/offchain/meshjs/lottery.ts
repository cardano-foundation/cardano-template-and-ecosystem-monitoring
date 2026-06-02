import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  deserializeDatum,
  integer,
  mConStr,
  mConStr0,
  mConStr1,
  resolvePaymentKeyHash,
  resolveScriptHash,
  scriptHash,
  serializePlutusScript,
  stringToHex,
  hexToString,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blake2b from "blake2b";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// Lottery: two validators (creator mint + lottery spend), commit-reveal between two players.
// Scenario: create → reveal1 → reveal2 → settle (happy path; winner = (nonce1+nonce2) mod 2).
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const TOKEN_NAME = "LOTTERY_TOKEN";
const GAME_INDEX = 19;
const END_REVEAL = 9_999_999_999_999;
const DELTA = 20;
const BET_AMOUNT = "10000000";
const SECRET1 = "3";
const SECRET2 = "4";
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

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hashSecret(s: string): string {
  return bytesToHex(blake2b(blake2b.BYTES).update(new TextEncoder().encode(s)).digest());
}

function getValidator(prefix: string): string {
  const v = blueprint.validators.find((x) => x.title.startsWith(prefix));
  if (!v) throw new Error(`Validator not found: ${prefix}`);
  return v.compiledCode;
}
function getScriptAddress(compiled: string) {
  const { address } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return address;
}

function loadScripts() {
  const creatorCompiled = applyParamsToScript(
    getValidator("lottery_creator."),
    [integer(GAME_INDEX)],
    "JSON",
  );
  const creatorPolicyId = resolveScriptHash(creatorCompiled, "V3");
  const lotteryCompiled = applyParamsToScript(
    getValidator("lottery."),
    [scriptHash(creatorPolicyId), integer(GAME_INDEX)],
    "JSON",
  );
  return {
    creator: { script: creatorCompiled, policyId: creatorPolicyId },
    lottery: { script: lotteryCompiled, address: getScriptAddress(lotteryCompiled) },
  };
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

async function getLotteryUtxo(scriptAddr: string): Promise<UTxO> {
  for (let i = 0; i < 60; i++) {
    const utxos = await provider().fetchAddressUTxOs(scriptAddr);
    const u = utxos.find((x) => x.output.plutusData);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Lottery state UTxO not found");
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

interface LotteryDatum {
  player1: string;
  player2: string;
  commit1: string;
  commit2: string;
  nonce1: string;
  nonce2: string;
  endReveal: number;
  delta: number;
}
function encodeDatum(d: LotteryDatum): unknown {
  return mConStr0([
    d.player1, d.player2, d.commit1, d.commit2,
    d.nonce1, d.nonce2, d.endReveal, d.delta,
  ]);
}
function decodeDatum(plutusDataHex: string): LotteryDatum {
  const d = deserializeDatum(plutusDataHex) as {
    fields: Array<{ bytes?: string; int?: string | number | bigint }>;
  };
  const f = d.fields;
  return {
    player1: f[0].bytes ?? "",
    player2: f[1].bytes ?? "",
    commit1: f[2].bytes ?? "",
    commit2: f[3].bytes ?? "",
    nonce1: f[4].bytes ?? "",
    nonce2: f[5].bytes ?? "",
    endReveal: Number(f[6].int ?? 0),
    delta: Number(f[7].int ?? 0),
  };
}

async function create(
  coordinator: MeshWallet,
  player1: MeshWallet,
  player2: MeshWallet,
) {
  const { creator, lottery } = loadScripts();
  const coordAddr = await coordinator.getChangeAddress();
  const player1Addr = await player1.getChangeAddress();
  const player2Addr = await player2.getChangeAddress();
  const player1Vkh = resolvePaymentKeyHash(player1Addr);
  const player2Vkh = resolvePaymentKeyHash(player2Addr);
  const datum: LotteryDatum = {
    player1: player1Vkh,
    player2: player2Vkh,
    commit1: hashSecret(SECRET1),
    commit2: hashSecret(SECRET2),
    nonce1: "",
    nonce2: "",
    endReveal: END_REVEAL,
    delta: DELTA,
  };
  const tokenUnit = creator.policyId + stringToHex(TOKEN_NAME);
  const utxos = await provider().fetchAddressUTxOs(coordAddr);
  const collateral: UTxO[] = await coordinator.getCollateral();

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .mintPlutusScriptV3()
    .mint("1", creator.policyId, stringToHex(TOKEN_NAME))
    // Inline minting script (vs. mintTxInReference): no on-chain reference UTxO infrastructure here.
    .mintingScript(creator.script)
    .mintRedeemerValue(mConStr0([]))
    .txOut(lottery.address, [
      { unit: "lovelace", quantity: BET_AMOUNT },
      { unit: tokenUnit, quantity: "1" },
    ])
    .txOutInlineDatumValue(encodeDatum(datum))
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(player1Vkh)
    .requiredSignerHash(player2Vkh)
    .changeAddress(coordAddr)
    .selectUtxosFrom(utxos)
    .complete();
  // Both players are required signers (datum binds them); coordinator funds + holds the tx.
  let signed = await coordinator.signTx(tx.txHex, true);
  signed = await player1.signTx(signed, true);
  signed = await player2.signTx(signed, true);
  const txHash = await coordinator.submitTx(signed);
  console.log(`CREATE ok. tx=${txHash}`);
}

async function reveal(player: MeshWallet, playerIdx: 1 | 2, secret: string) {
  const { lottery } = loadScripts();
  const utxo = await getLotteryUtxo(lottery.address);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const current = decodeDatum(utxo.output.plutusData);
  const secretHex = stringToHex(secret);
  const updated: LotteryDatum = {
    ...current,
    nonce1: playerIdx === 1 ? secretHex : current.nonce1,
    nonce2: playerIdx === 2 ? secretHex : current.nonce2,
  };
  const redeemer = mConStr(playerIdx === 1 ? 0 : 1, [secretHex]);
  const myAddr = await player.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  const ownUtxos = await provider().fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await player.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, lottery.address)
    .txInScript(lottery.script)
    .txInRedeemerValue(redeemer)
    .txInInlineDatumPresent()
    .txOut(lottery.address, utxo.output.amount.map((a) => ({ unit: a.unit, quantity: a.quantity })))
    .txOutInlineDatumValue(encodeDatum(updated))
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
  const signed = await player.signTx(tx.txHex);
  const txHash = await player.submitTx(signed);
  console.log(`REVEAL${playerIdx} ok. tx=${txHash}`);
}

async function settle(player1: MeshWallet, player2: MeshWallet) {
  const { creator, lottery } = loadScripts();
  const utxo = await getLotteryUtxo(lottery.address);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const current = decodeDatum(utxo.output.plutusData);
  const n1 = Number(hexToString(current.nonce1));
  const n2 = Number(hexToString(current.nonce2));
  const winnerVkh = (n1 + n2) % 2 === 1 ? current.player1 : current.player2;
  const addr1 = await player1.getChangeAddress();
  const vkh1 = resolvePaymentKeyHash(addr1);
  const winner = winnerVkh === vkh1 ? player1 : player2;
  const winnerAddr = await winner.getChangeAddress();
  const winnerVkhActual = resolvePaymentKeyHash(winnerAddr);

  const tokenUnit = creator.policyId + stringToHex(TOKEN_NAME);
  const ownUtxos = await provider().fetchAddressUTxOs(winnerAddr);
  const collateral: UTxO[] = await winner.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, lottery.address)
    .txInScript(lottery.script)
    .txInRedeemerValue(mConStr(4, []))
    .txInInlineDatumPresent()
    .mintPlutusScriptV3()
    .mint("-1", creator.policyId, stringToHex(TOKEN_NAME))
    .mintingScript(creator.script)
    .mintRedeemerValue(mConStr1([]))
    .txOut(winnerAddr, [{ unit: "lovelace", quantity: BET_AMOUNT }])
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(winnerVkhActual)
    .changeAddress(winnerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await winner.signTx(tx.txHex);
  const txHash = await winner.submitTx(signed);
  console.log(`SETTLE ok. winner=${winnerVkh.slice(0, 16)}… tx=${txHash}`);
}

async function runScenario() {
  console.log("=== lottery scenario: create → reveal1 → reveal2 → settle ===");
  // Roles: coordinator submits create + funds, player1/player2 commit secrets and reveal/settle.
  const coordinator = makeWallet(MeshWallet.brew(false) as string[]);
  const player1 = makeWallet(MeshWallet.brew(false) as string[]);
  const player2 = makeWallet(MeshWallet.brew(false) as string[]);
  await fundFromFunder([
    { addr: await coordinator.getChangeAddress(), lovelace: 30_000_000n },
    { addr: await player1.getChangeAddress(), lovelace: 30_000_000n },
    { addr: await player2.getChangeAddress(), lovelace: 30_000_000n },
  ]);

  await create(coordinator, player1, player2);
  await new Promise((r) => setTimeout(r, 2000));
  await reveal(player1, 1, SECRET1);
  await new Promise((r) => setTimeout(r, 2000));
  await reveal(player2, 2, SECRET2);
  await new Promise((r) => setTimeout(r, 2000));
  await settle(player1, player2);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
