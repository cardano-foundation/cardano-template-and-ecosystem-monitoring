import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  applyParamsToScript,
  fromText,
  paymentCredentialOf,
  toText,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
} from "@evolution-sdk/lucid";
import blake2b from "blake2b";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Commit-reveal lottery. Two PlutusV3 validators (lottery_creator mint +
// lottery spend) exercise Create -> Reveal1 -> Reveal2 -> Settle; the
// winner is decided by parity of the two revealed nonces.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const TOKEN_NAME = "LOTTERY_TOKEN";
const GAME_INDEX = 19n;
// Far-future POSIX so reveals never trip the deadline in a demo run.
const END_REVEAL = 9_999_999_999_999n;
const DELTA = 20n;
const BET_LOVELACE = 10_000_000n;
const SECRET1 = "3";
const SECRET2 = "4";

async function lucidAt(accountIndex: number): Promise<LucidEvolution> {
  const lucid = await Lucid(new Blockfrost(YACI_URL, "Dummy Key"), NETWORK);
  lucid.selectWallet.fromSeed(TEST_MNEMONIC, { accountIndex });
  return lucid;
}

async function vkhOf(accountIndex: number): Promise<string> {
  const l = await lucidAt(accountIndex);
  return paymentCredentialOf(await l.wallet().address()).hash;
}

async function waitForUtxosAt(
  lucid: LucidEvolution,
  address: string,
  minCount: number,
  timeoutSec = 60,
) {
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await lucid.utxosAt(address);
      if (u.length >= minCount) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${address}`);
}

async function fundFromIndex0(targets: Array<{ address: string; lovelace: bigint }>) {
  const lucid = await lucidAt(0);
  let txb = lucid.newTx();
  for (const t of targets) txb = txb.pay.ToAddress(t.address, { lovelace: t.lovelace });
  const tx = await txb.complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Funded ${targets.length} target(s). tx=${txHash}`);
  for (const t of targets) await waitForUtxosAt(lucid, t.address, 1, 60);
  // Funder is the next caller — wait for its own new change UTxO so lucid
  // doesn't re-select the spent input.
  const funderAddr = await lucid.wallet().address();
  for (let i = 0; i < 60; i++) {
    const u = await lucid.utxosAt(funderAddr);
    if (u.some((x) => x.txHash === txHash)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
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

function loadScripts() {
  const creatorScript: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(getValidator("lottery_creator."), [GAME_INDEX]),
  };
  const creatorPolicyId = validatorToScriptHash(creatorScript);
  const lotteryScript: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(getValidator("lottery."), [creatorPolicyId, GAME_INDEX]),
  };
  return {
    creator: { script: creatorScript, policyId: creatorPolicyId },
    lottery: { script: lotteryScript, address: validatorToAddress(NETWORK, lotteryScript) },
  };
}

interface LotteryDatum {
  player1: string;
  player2: string;
  commit1: string;
  commit2: string;
  nonce1: string;
  nonce2: string;
  endReveal: bigint;
  delta: bigint;
}
function encodeDatum(d: LotteryDatum): string {
  return Data.to(
    new Constr(0, [
      d.player1, d.player2, d.commit1, d.commit2,
      d.nonce1, d.nonce2, d.endReveal, d.delta,
    ]),
  );
}
function decodeDatum(datumHex: string): LotteryDatum {
  const c = Data.from(datumHex) as Constr<Data>;
  return {
    player1: c.fields[0] as string,
    player2: c.fields[1] as string,
    commit1: c.fields[2] as string,
    commit2: c.fields[3] as string,
    nonce1: c.fields[4] as string,
    nonce2: c.fields[5] as string,
    endReveal: c.fields[6] as bigint,
    delta: c.fields[7] as bigint,
  };
}

async function getLotteryUtxo(lucid: LucidEvolution, address: string) {
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(address);
    const u = utxos.find((x) => x.datum);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Lottery state UTxO not found");
}

async function create(
  coordinator: LucidEvolution,
  player1Lucid: LucidEvolution,
  player2Lucid: LucidEvolution,
) {
  const { creator, lottery } = loadScripts();
  const player1Vkh = paymentCredentialOf(await player1Lucid.wallet().address()).hash;
  const player2Vkh = paymentCredentialOf(await player2Lucid.wallet().address()).hash;
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
  const tokenUnit = creator.policyId + fromText(TOKEN_NAME);
  const tx = await coordinator
    .newTx()
    .mintAssets({ [tokenUnit]: 1n }, Data.to(new Constr(0, [])))
    .attach.MintingPolicy(creator.script)
    .pay.ToContract(
      lottery.address,
      { kind: "inline", value: encodeDatum(datum) },
      { lovelace: BET_LOVELACE, [tokenUnit]: 1n },
    )
    .addSigner(await player1Lucid.wallet().address())
    .addSigner(await player2Lucid.wallet().address())
    .complete();
  const partial1 = await player1Lucid.fromTx(tx.toCBOR()).partialSign.withWallet();
  const partial2 = await player2Lucid.fromTx(tx.toCBOR()).partialSign.withWallet();
  const signed = await tx.sign.withWallet().assemble([partial1, partial2]).complete();
  const txHash = await signed.submit();
  console.log(`CREATE ok. tx=${txHash}`);
}

async function reveal(playerLucid: LucidEvolution, player: 1 | 2, secret: string) {
  const { lottery } = loadScripts();
  const utxo = await getLotteryUtxo(playerLucid, lottery.address);
  const current = decodeDatum(utxo.datum!);
  const secretHex = fromText(secret);
  const updated: LotteryDatum = {
    ...current,
    nonce1: player === 1 ? secretHex : current.nonce1,
    nonce2: player === 2 ? secretHex : current.nonce2,
  };
  const redeemer = Data.to(new Constr(player === 1 ? 0 : 1, [secretHex]));
  const myAddr = await playerLucid.wallet().address();
  const tx = await playerLucid
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(lottery.script)
    .pay.ToContract(
      lottery.address,
      { kind: "inline", value: encodeDatum(updated) },
      utxo.assets,
    )
    .addSigner(myAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`REVEAL${player} ok. tx=${txHash}`);
}

async function settle(lucid1: LucidEvolution, lucid2: LucidEvolution) {
  const { creator, lottery } = loadScripts();
  const utxo = await getLotteryUtxo(lucid1, lottery.address);
  const current = decodeDatum(utxo.datum!);
  const n1 = Number(toText(current.nonce1));
  const n2 = Number(toText(current.nonce2));
  const winnerVkh = (n1 + n2) % 2 === 1 ? current.player1 : current.player2;
  const addr1 = await lucid1.wallet().address();
  const addr2 = await lucid2.wallet().address();
  const vkh1 = paymentCredentialOf(addr1).hash;
  const winnerLucid = winnerVkh === vkh1 ? lucid1 : lucid2;
  const winnerAddr = winnerVkh === vkh1 ? addr1 : addr2;

  const tokenUnit = creator.policyId + fromText(TOKEN_NAME);
  const tx = await winnerLucid
    .newTx()
    .collectFrom([utxo], Data.to(new Constr(4, [])))
    .attach.SpendingValidator(lottery.script)
    .mintAssets({ [tokenUnit]: -1n }, Data.to(new Constr(1, [])))
    .attach.MintingPolicy(creator.script)
    .pay.ToAddress(winnerAddr, { lovelace: BET_LOVELACE })
    .addSigner(winnerAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`SETTLE ok. winner=${winnerVkh.slice(0, 16)}… tx=${txHash}`);
}

async function runScenario() {
  console.log("=== lottery scenario: create → reveal1 → reveal2 → settle ===");
  // account 0 = coordinator / funder ; 1 = player1 ; 2 = player2
  const coordinator = await lucidAt(0);
  const player1Lucid = await lucidAt(1);
  const player2Lucid = await lucidAt(2);
  await fundFromIndex0([
    { address: await player1Lucid.wallet().address(), lovelace: 30_000_000n },
    { address: await player2Lucid.wallet().address(), lovelace: 30_000_000n },
  ]);

  await create(coordinator, player1Lucid, player2Lucid);
  await new Promise((r) => setTimeout(r, 2000));
  await reveal(player1Lucid, 1, SECRET1);
  await new Promise((r) => setTimeout(r, 2000));
  await reveal(player2Lucid, 2, SECRET2);
  await new Promise((r) => setTimeout(r, 2000));
  await settle(player1Lucid, player2Lucid);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
