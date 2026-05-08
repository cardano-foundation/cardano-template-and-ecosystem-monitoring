import {
  KoiosProvider,
  MeshTxBuilder,
  MeshWallet,
  deserializeAddress,
  deserializeDatum,
  mConStr0,
  mConStr1,
  mConStr2,
  resolvePaymentKeyHash,
  serializePlutusScript,
  type UTxO,
} from "@meshsdk/core";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Pricebet — Mesh.js port.
//
// Validator: no parameters.
// Datum: PriceBetDatum {
//   owner: VKH,
//   player: Option<VKH>,        // Constr 0 [VKH] for Some, Constr 1 [] for None
//   oracle_vkh: VKH,
//   target_rate: Int,
//   deadline: Int (POSIX ms),
//   bet_amount: Int (lovelace),
// }
// Redeemer:
//   Join     = Constr 0 []
//   Win      = Constr 1 []
//   Timeout  = Constr 2 []
// ----------------------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;
const ORACLE_ADDRESS =
  "addr_test1qr6tq95wj9hkte4cr7v4ggwf4l8kmu0ejq5w2pktthjc3kte2q8lazrsrxxhkfzzmxe6fsjj434p0q384cgywdnan5qw0wwsy";

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
  const { address: scriptAddress } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script: compiled, scriptAddress };
}

interface PriceBetDatum {
  owner: string;
  player: string | null; // VKH hex when Some, null when None
  oracleVkh: string;
  targetRate: bigint;
  deadline: bigint;
  betAmount: bigint;
}

function encodeDatum(d: PriceBetDatum): unknown {
  // player is Option<ByteArray>: Constr 0 [vkh] / Constr 1 []
  const playerOption = d.player === null ? mConStr1([]) : mConStr0([d.player]);
  return mConStr0([d.owner, playerOption, d.oracleVkh, d.targetRate, d.deadline, d.betAmount]);
}

function decodeDatum(datumHex: string): PriceBetDatum {
  const decoded = deserializeDatum(datumHex) as {
    fields: Array<
      | { bytes?: string }
      | { fields?: Array<{ bytes?: string }>; index?: number; constructor?: number }
      | { int?: bigint }
    >;
  };
  const owner = (decoded.fields[0] as { bytes: string }).bytes;
  const playerField = decoded.fields[1] as {
    fields?: Array<{ bytes?: string }>;
    constructor?: number;
    index?: number;
  };
  const ctorIdx = playerField.constructor ?? playerField.index ?? 0;
  const player = ctorIdx === 0 && playerField.fields && playerField.fields[0]
    ? (playerField.fields[0].bytes ?? null)
    : null;
  const oracleVkh = (decoded.fields[2] as { bytes: string }).bytes;
  const targetRate = BigInt((decoded.fields[3] as { int: bigint }).int ?? 0);
  const deadline = BigInt((decoded.fields[4] as { int: bigint }).int ?? 0);
  const betAmount = BigInt((decoded.fields[5] as { int: bigint }).int ?? 0);
  return { owner, player, oracleVkh, targetRate, deadline, betAmount };
}

export async function createBet(
  walletFile: string,
  targetRate: number,
  deadlineInMs: number,
  betAmountAda: number,
) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);
  const { scriptAddress } = getScriptInfo();

  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const oracleVkh = deserializeAddress(ORACLE_ADDRESS).pubKeyHash;

  const betLovelace = BigInt(betAmountAda) * 1_000_000n;
  const deadline = BigInt(Date.now() + deadlineInMs);

  const datum: PriceBetDatum = {
    owner: ownerVkh,
    player: null,
    oracleVkh,
    targetRate: BigInt(targetRate),
    deadline,
    betAmount: betLovelace,
  };

  const utxos = await provider.fetchAddressUTxOs(ownerAddr);

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: betLovelace.toString() }])
    .txOutInlineDatumValue(encodeDatum(datum), "JSON")
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Bet created. Tx: ${txHash}`);
  console.log(`Script address: ${scriptAddress}`);
}

export async function joinBet(walletFile: string, betTxHash: string, betIndex: number) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);
  const { script, scriptAddress } = getScriptInfo();

  const playerAddr = await wallet.getChangeAddress();
  const playerVkh = resolvePaymentKeyHash(playerAddr);

  const utxos = await provider.fetchUTxOs(betTxHash);
  const utxo = utxos.find((u) => u.input.outputIndex === betIndex);
  if (!utxo) throw new Error(`No UTxO at ${betTxHash}#${betIndex}`);
  if (!utxo.output.plutusData) throw new Error("UTxO has no inline datum");

  const current = decodeDatum(utxo.output.plutusData);
  if (current.player !== null) throw new Error("Bet already joined");

  const updated: PriceBetDatum = { ...current, player: playerVkh };
  const totalPot = current.betAmount * 2n;

  const ownUtxos = await provider.fetchAddressUTxOs(playerAddr);
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
    .txInRedeemerValue(mConStr0([]), "JSON") // Join
    .txInInlineDatumPresent()
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: totalPot.toString() }])
    .txOutInlineDatumValue(encodeDatum(updated), "JSON")
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(playerVkh)
    .invalidHereafter(Math.floor(Number(current.deadline) / 1000))
    .changeAddress(playerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Bet joined. Tx: ${txHash}`);
}

export async function timeoutBet(walletFile: string, betTxHash: string, betIndex: number) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);
  const { script } = getScriptInfo();

  const ownerAddr = await wallet.getChangeAddress();
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);

  const utxos = await provider.fetchUTxOs(betTxHash);
  const utxo = utxos.find((u) => u.input.outputIndex === betIndex);
  if (!utxo) throw new Error(`No UTxO at ${betTxHash}#${betIndex}`);
  if (!utxo.output.plutusData) throw new Error("UTxO has no inline datum");

  const current = decodeDatum(utxo.output.plutusData);

  const ownUtxos = await provider.fetchAddressUTxOs(ownerAddr);
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
    .txInRedeemerValue(mConStr2([]), "JSON") // Timeout
    .txInInlineDatumPresent()
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    .invalidBefore(Math.floor(Number(current.deadline) / 1000) + 1)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Bet timed out. Tx: ${txHash}`);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  try {
    if (cmd === "create") {
      if (args.length !== 4) {
        throw new Error(
          "Usage: create <wallet> <target_rate> <deadline_ms_from_now> <bet_ada>",
        );
      }
      await createBet(args[0], Number(args[1]), Number(args[2]), Number(args[3]));
    } else if (cmd === "join") {
      if (args.length !== 3) throw new Error("Usage: join <wallet> <bet_tx_hash> <index>");
      await joinBet(args[0], args[1], Number(args[2]));
    } else if (cmd === "timeout") {
      if (args.length !== 3) throw new Error("Usage: timeout <wallet> <bet_tx_hash> <index>");
      await timeoutBet(args[0], args[1], Number(args[2]));
    } else {
      console.log(
        "Usage:\n" +
          "  create <wallet> <target_rate> <deadline_ms> <bet_ada>\n" +
          "  join <wallet> <bet_tx_hash> <index>\n" +
          "  timeout <wallet> <bet_tx_hash> <index>\n",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
