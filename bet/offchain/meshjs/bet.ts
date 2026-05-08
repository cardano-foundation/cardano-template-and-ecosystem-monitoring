import {
  KoiosProvider,
  MeshTxBuilder,
  MeshWallet,
  resolvePaymentKeyHash,
  resolveScriptHash,
  serializePlutusScript,
  stringToHex,
  mConStr0,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Bet — Mesh.js port.
//
// Validator (single script provides both mint policy and spend validator):
//   Datum: BetDatum { player1: VKH, player2: VKH, oracle: VKH, expiration: Int }
//   Action: JOIN | ANNOUNCE_WINNER { winner: VKH }
//   Mint:  validates initialization (player1 signs, output to script with marker token)
//   Spend (JOIN): player2 fills in their VKH on the continuing UTxO
//   Spend (ANNOUNCE_WINNER): oracle picks winner and triggers payout
//
// This file ports the init + join happy path; the announce-winner path can be
// added later by mirroring evosdk/bet.ts.
// ----------------------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;
const ASSET_NAME = "LuckyNumberSlevin";

function loadWallet(walletFile: string): MeshWallet {
  const mnemonic = Deno.readTextFileSync(walletFile).trim();
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: new KoiosProvider(NETWORK),
    submitter: new KoiosProvider(NETWORK),
    key: { type: "mnemonic", words: mnemonic.split(" ") },
  });
}

function getScriptInfo() {
  const compiled = blueprint.validators[0].compiledCode;
  // No validator parameters.
  const script = applyParamsToScript(compiled, [], "JSON");
  const policyId = resolveScriptHash(script, "V3");
  const { address: scriptAddress } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, policyId, scriptAddress };
}

async function vkhFor(walletFile: string): Promise<string> {
  const w = loadWallet(walletFile);
  const addr = await w.getChangeAddress();
  return resolvePaymentKeyHash(addr);
}

/**
 * init — player1 mints the bet marker token and locks `lovelace` at the script
 * with the initial datum (player2 = empty bytes until someone joins).
 */
export async function init(player1Wallet: string, oracleWallet: string, lovelace: string) {
  const wallet = loadWallet(player1Wallet);
  const provider = new KoiosProvider(NETWORK);

  const { script, policyId, scriptAddress } = getScriptInfo();
  const player1Addr = await wallet.getChangeAddress();
  const player1Vkh = resolvePaymentKeyHash(player1Addr);
  const oracleVkh = await vkhFor(oracleWallet);

  // Datum: BetDatum { player1, player2 = "", oracle, expiration = now + 5 days }
  const expiration = Date.now() + 5 * 24 * 60 * 60 * 1000;
  const datum = mConStr0([player1Vkh, "", oracleVkh, expiration]);

  const utxos = await provider.fetchAddressUTxOs(player1Addr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .mintPlutusScriptV3()
    .mint("1", policyId, stringToHex(ASSET_NAME))
    .mintingScript(script)
    // Mint redeemer is `Data` (unused by the validator). Use unit.
    .mintRedeemerValue(mConStr0([]), "JSON")
    .txOut(
      scriptAddress,
      [
        { unit: "lovelace", quantity: lovelace },
        { unit: policyId + stringToHex(ASSET_NAME), quantity: "1" },
      ],
    )
    .txOutInlineDatumValue(datum, "JSON")
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(player1Vkh)
    .changeAddress(player1Addr)
    .selectUtxosFrom(utxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Bet initialised. Tx: ${txHash}`);
  console.log(`Use:  deno run -A bet.ts join <wallet> <txHash>`);
}

/**
 * join — player2 spends the script UTxO created by `init`, refunds the same
 * marker token + double the lovelace, and writes their own VKH into the datum.
 */
export async function join(player2Wallet: string, initTxHash: string) {
  const wallet = loadWallet(player2Wallet);
  const provider = new KoiosProvider(NETWORK);

  const { script, policyId, scriptAddress } = getScriptInfo();
  const player2Addr = await wallet.getChangeAddress();
  const player2Vkh = resolvePaymentKeyHash(player2Addr);

  // Locate the bet UTxO at output index 0 of the init tx.
  const utxos = await provider.fetchUTxOs(initTxHash);
  const utxo = utxos.find((u) => u.input.outputIndex === 0);
  if (!utxo) throw new Error(`No UTxO at outputIndex 0 of ${initTxHash}`);
  if (!utxo.output.plutusData) throw new Error("UTxO has no inline datum");

  // Decode the existing datum and rewrite player2.
  // BetDatum is Constr 0 [vkh, vkh, vkh, int]
  const inlineHex = utxo.output.plutusData;
  const { deserializeDatum } = await import("@meshsdk/core");
  const decoded = deserializeDatum(inlineHex) as {
    fields: Array<{ bytes?: string; int?: bigint }>;
  };
  const player1Vkh = (decoded.fields[0].bytes ?? "");
  const oracleVkh = (decoded.fields[2].bytes ?? "");
  const expiration = Number(decoded.fields[3].int ?? 0);

  const newDatum = mConStr0([player1Vkh, player2Vkh, oracleVkh, expiration]);

  // Pot doubles: player2 matches player1's stake.
  const lovelaceIn = utxo.output.amount.find((a) => a.unit === "lovelace")!.quantity;
  const newLovelace = (BigInt(lovelaceIn) * 2n).toString();

  const ownUtxos = await provider.fetchAddressUTxOs(player2Addr);
  const collateral: UTxO[] = await wallet.getCollateral();

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
    .txInScript(script)
    .txInRedeemerValue(mConStr0([]), "JSON") // JOIN = Constr 0 []
    .txInInlineDatumPresent()
    .txOut(
      scriptAddress,
      [
        { unit: "lovelace", quantity: newLovelace },
        { unit: policyId + stringToHex(ASSET_NAME), quantity: "1" },
      ],
    )
    .txOutInlineDatumValue(newDatum, "JSON")
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(player2Vkh)
    .changeAddress(player2Addr)
    .selectUtxosFrom(ownUtxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Joined bet. Tx: ${txHash}`);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  if (!cmd) {
    console.log(
      "Usage:\n" +
        "  init <player1.wallet> <oracle.wallet> <lovelace>\n" +
        "  join <player2.wallet> <init_tx_hash>\n",
    );
  } else if (cmd === "init") {
    if (args.length !== 3) console.error("Usage: init <player1.wallet> <oracle.wallet> <lovelace>");
    else await init(args[0], args[1], args[2]);
  } else if (cmd === "join") {
    if (args.length !== 2) console.error("Usage: join <player2.wallet> <init_tx_hash>");
    else await join(args[0], args[1]);
  } else {
    console.log("Unknown command");
  }
}
