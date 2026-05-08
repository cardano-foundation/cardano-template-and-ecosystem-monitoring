import {
  Lucid,
  Koios,
  applyParamsToScript,
  Constr,
  Data,
  fromText,
  toText,
  generateSeedPhrase,
  paymentCredentialOf,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
} from "@evolution-sdk/lucid";
import blake2b from "blake2b";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Lottery — Evolution SDK port.
//
// 2 validators with chained parameters:
//   lottery_creator (mint)  param: game_index (Int)
//   lottery         (spend) params: creator_script_hash, game_index
//
// LotteryDatum = Constr 0 [
//   player1_vkh, player2_vkh,
//   commit1 (blake2b_256 hex), commit2,
//   nonce1 (hex bytes, "" before reveal), nonce2,
//   end_reveal (Int), delta (Int)
// ]
// Spend redeemers:
//   0 Reveal1 [secret_bytes]
//   1 Reveal2 [secret_bytes]
//   2 Timeout1
//   3 Timeout2
//   4 Settle
// Mint redeemer: 0 mint / 1 burn.
// ----------------------------------------------------------------------------

const KOIOS_URL = "https://preprod.koios.rest/api/v1";
const TOKEN_NAME = "LOTTERY_TOKEN";

// Hardcoded mirror of the meshjs reference for happy-path testing.
const GAME_INDEX = 19n;
const END_REVEAL = 100n;
const DELTA = 20n;
const BET_LOVELACE = 10_000_000n;
const SECRET1 = "3";
const SECRET2 = "4";

function selectWallet(lucid: LucidEvolution, fileName: string) {
  const mnemonic = JSON.parse(Deno.readTextFileSync(fileName));
  lucid.selectWallet.fromSeed(
    Array.isArray(mnemonic) ? mnemonic.join(" ") : mnemonic,
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hashSecret(s: string): string {
  const bytes = new TextEncoder().encode(s);
  const hash = blake2b(blake2b.BYTES).update(bytes).digest();
  return bytesToHex(hash);
}

async function prepare(amount: number) {
  for (let i = 0; i < amount; i++) {
    const fileName = `wallet_${i}.json`;
    try {
      await Deno.stat(fileName);
      console.log(`${fileName} already exists, skipping.`);
    } catch {
      const mnemonic = generateSeedPhrase();
      await Deno.writeTextFile(fileName, JSON.stringify(mnemonic.split(" ")));
      const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
      lucid.selectWallet.fromSeed(mnemonic);
      console.log(`Generated ${fileName}. Address: ${await lucid.wallet().address()}`);
    }
  }
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
    lottery: {
      script: lotteryScript,
      address: validatorToAddress("Preprod", lotteryScript),
    },
  };
}

interface LotteryDatum {
  player1: string;
  player2: string;
  commit1: string;
  commit2: string;
  nonce1: string; // "" before reveal
  nonce2: string;
  endReveal: bigint;
  delta: bigint;
}

function encodeDatum(d: LotteryDatum): string {
  return Data.to(
    new Constr(0, [
      d.player1,
      d.player2,
      d.commit1,
      d.commit2,
      d.nonce1,
      d.nonce2,
      d.endReveal,
      d.delta,
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
  const utxos = await lucid.utxosAt(address);
  const stateUtxo = utxos.find((u) => u.datum);
  if (!stateUtxo) throw new Error("Lottery state UTxO not found");
  return stateUtxo;
}

export async function multisigCreate(
  coordinatorWallet: string,
  player1Wallet: string,
  player2Wallet: string,
) {
  // Each player and the coordinator must sign — use a fresh Lucid for each
  // wallet so signing keys aren't trampled.
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid, coordinatorWallet);

  const { creator, lottery } = loadScripts();
  const coordAddr = await lucid.wallet().address();

  const player1Lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(player1Lucid, player1Wallet);
  const player1Vkh = paymentCredentialOf(await player1Lucid.wallet().address()).hash;

  const player2Lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(player2Lucid, player2Wallet);
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

  const tx = await lucid
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

  console.log("Lottery created with marker token");
  console.log("Script address:", lottery.address);
  console.log("Policy ID:", creator.policyId);
  console.log("Tx:", txHash);
  void coordAddr;
}

async function revealCommon(walletFile: string, player: 1 | 2, secret: string) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid, walletFile);
  const { lottery } = loadScripts();

  const utxo = await getLotteryUtxo(lucid, lottery.address);
  const current = decodeDatum(utxo.datum!);
  const secretHex = fromText(secret);

  const updated: LotteryDatum = {
    ...current,
    nonce1: player === 1 ? secretHex : current.nonce1,
    nonce2: player === 2 ? secretHex : current.nonce2,
  };

  // Reveal redeemer index: 0 for Reveal1, 1 for Reveal2.
  const redeemer = Data.to(new Constr(player === 1 ? 0 : 1, [secretHex]));

  const myAddr = await lucid.wallet().address();

  const tx = await lucid
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
  console.log(`Reveal${player} submitted. Tx: ${txHash}`);
}

export async function reveal1(walletFile: string) {
  await revealCommon(walletFile, 1, SECRET1);
}

export async function reveal2(walletFile: string) {
  await revealCommon(walletFile, 2, SECRET2);
}

export async function settle(wallet1File: string, wallet2File: string) {
  const lucid1 = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid1, wallet1File);
  const lucid2 = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid2, wallet2File);

  const { creator, lottery } = loadScripts();
  const utxo = await getLotteryUtxo(lucid1, lottery.address);
  const current = decodeDatum(utxo.datum!);

  const n1 = Number(toText(current.nonce1));
  const n2 = Number(toText(current.nonce2));
  if (Number.isNaN(n1) || Number.isNaN(n2)) {
    throw new Error("Both secrets must be revealed before settlement");
  }

  // Mirror the on-chain choice: parity of (n1+n2) picks the winner.
  const winnerVkh = (n1 + n2) % 2 === 1 ? current.player1 : current.player2;
  const addr1 = await lucid1.wallet().address();
  const addr2 = await lucid2.wallet().address();
  const vkh1 = paymentCredentialOf(addr1).hash;
  const vkh2 = paymentCredentialOf(addr2).hash;

  let winnerLucid: LucidEvolution;
  let winnerAddr: string;
  if (winnerVkh === vkh1) {
    winnerLucid = lucid1;
    winnerAddr = addr1;
  } else if (winnerVkh === vkh2) {
    winnerLucid = lucid2;
    winnerAddr = addr2;
  } else {
    throw new Error("Neither wallet matches the winning VKH");
  }

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
  console.log("Lottery settled");
  console.log("Winner VKH:", winnerVkh);
  console.log("Tx:", txHash);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  try {
    if (cmd === "prepare") {
      await prepare(args[0] ? Number(args[0]) : 3);
    } else if (cmd === "multisig-create") {
      if (args.length !== 3) {
        throw new Error("Usage: multisig-create <wallet_0.json> <wallet_1.json> <wallet_2.json>");
      }
      await multisigCreate(args[0], args[1], args[2]);
    } else if (cmd === "reveal1") {
      if (!args[0]) throw new Error("Usage: reveal1 <wallet.json>");
      await reveal1(args[0]);
    } else if (cmd === "reveal2") {
      if (!args[0]) throw new Error("Usage: reveal2 <wallet.json>");
      await reveal2(args[0]);
    } else if (cmd === "settle") {
      if (args.length !== 2) throw new Error("Usage: settle <wallet_1.json> <wallet_2.json>");
      await settle(args[0], args[1]);
    } else {
      console.log(
        "Usage:\n" +
          "  prepare [count]\n" +
          "  multisig-create <wallet_0.json> <wallet_1.json> <wallet_2.json>\n" +
          "  reveal1 <wallet.json>\n" +
          "  reveal2 <wallet.json>\n" +
          "  settle <wallet_1.json> <wallet_2.json>\n",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
