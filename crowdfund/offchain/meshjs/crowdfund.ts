import {
  KoiosProvider,
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

// ----------------------------------------------------------------------------
// Crowdfund — Mesh.js port.
//
// Validator parameters: (beneficiary: VKH, goal: Int, deadline: Int)
// Datum: CrowdfundDatum { wallets: Pairs<VKH, Int> } → Constr 0 [Map<bytes, int>]
// Redeemers: 0 DONATE, 1 WITHDRAW, 2 RECLAIM.
// ----------------------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;

function loadWallet(walletFile: string): MeshWallet {
  const mnemonic = JSON.parse(Deno.readTextFileSync(walletFile));
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: new KoiosProvider(NETWORK),
    submitter: new KoiosProvider(NETWORK),
    key: { type: "mnemonic", words: mnemonic },
  });
}

function loadValidator(beneficiaryVkh: string, goal: bigint, deadlineMs: bigint) {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(
    compiled,
    [{ bytes: beneficiaryVkh }, { int: goal.toString() }, { int: deadlineMs.toString() }],
    "JSON",
  );
  const { address: scriptAddress } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, scriptAddress };
}

// JSON-Data representation of Constr 0 [Map<bytes, int>]:
//   { constructor: 0, fields: [{ map: [{ k: { bytes }, v: { int } }, ...] }] }
function encodeDatum(wallets: Map<string, bigint>): Record<string, unknown> {
  return {
    constructor: 0,
    fields: [
      {
        map: [...wallets.entries()].map(([k, v]) => ({
          k: { bytes: k },
          v: { int: v.toString() },
        })),
      },
    ],
  };
}

function decodeDatum(datumHex: string): Map<string, bigint> {
  const decoded = deserializeDatum(datumHex) as {
    fields: Array<{ map?: Array<{ k: { bytes: string }; v: { int: bigint | string | number } }> }>;
  };
  const out = new Map<string, bigint>();
  const entries = decoded.fields[0]?.map ?? [];
  for (const entry of entries) {
    out.set(entry.k.bytes, BigInt(entry.v.int));
  }
  return out;
}

export async function init(
  walletFile: string,
  beneficiaryVkh: string,
  goal: number,
  deadlineMs: number,
  contributionLovelace: number,
) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);

  const { scriptAddress } = loadValidator(
    beneficiaryVkh,
    BigInt(goal),
    BigInt(deadlineMs),
  );

  const wallets = new Map<string, bigint>();
  wallets.set(myVkh, BigInt(contributionLovelace));
  const datum = encodeDatum(wallets);

  const utxos = await provider.fetchAddressUTxOs(myAddr);

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: contributionLovelace.toString() }])
    .txOutInlineDatumValue(datum, "JSON")
    .changeAddress(myAddr)
    .selectUtxosFrom(utxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log("Crowdfund initialised");
  console.log("Script address:", scriptAddress);
  console.log("Tx:", txHash);
}

async function findScriptUtxo(provider: KoiosProvider, scriptAddress: string): Promise<UTxO> {
  const utxos = await provider.fetchAddressUTxOs(scriptAddress);
  const utxo = utxos.find((u) => u.output.plutusData);
  if (!utxo) throw new Error("No script UTxO with datum found");
  return utxo;
}

function lovelaceOf(amounts: Array<{ unit: string; quantity: string }>): bigint {
  const a = amounts.find((x) => x.unit === "lovelace");
  return a ? BigInt(a.quantity) : 0n;
}

export async function donate(
  walletFile: string,
  beneficiaryVkh: string,
  goal: number,
  deadlineMs: number,
  amountLovelace: number,
) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);

  const { script, scriptAddress } = loadValidator(
    beneficiaryVkh,
    BigInt(goal),
    BigInt(deadlineMs),
  );

  const utxo = await findScriptUtxo(provider, scriptAddress);
  const wallets = decodeDatum(utxo.output.plutusData!);
  const prev = wallets.get(myVkh) ?? 0n;
  wallets.set(myVkh, prev + BigInt(amountLovelace));

  const newLovelace = lovelaceOf(utxo.output.amount) + BigInt(amountLovelace);

  const ownUtxos = await provider.fetchAddressUTxOs(myAddr);
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
    .txInRedeemerValue(mConStr0([]), "JSON") // DONATE
    .txInInlineDatumPresent()
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: newLovelace.toString() }])
    .txOutInlineDatumValue(encodeDatum(wallets), "JSON")
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

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log("Donation submitted. Tx:", txHash);
}

export async function withdraw(
  walletFile: string,
  beneficiaryVkh: string,
  goal: number,
  deadlineMs: number,
) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);
  if (myVkh !== beneficiaryVkh) {
    throw new Error("Withdraw must be signed by the beneficiary's wallet");
  }

  const { script, scriptAddress } = loadValidator(
    beneficiaryVkh,
    BigInt(goal),
    BigInt(deadlineMs),
  );

  const utxo = await findScriptUtxo(provider, scriptAddress);
  const lovelaceIn = lovelaceOf(utxo.output.amount);

  const ownUtxos = await provider.fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();
  const validFromMs = Math.max(deadlineMs, Date.now());

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
    .txInScript(script)
    .txInRedeemerValue(mConStr(1, []), "JSON") // WITHDRAW
    .txInInlineDatumPresent()
    .txOut(myAddr, [{ unit: "lovelace", quantity: lovelaceIn.toString() }])
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(myVkh)
    .invalidBefore(Math.floor(validFromMs / 1000))
    .invalidHereafter(Math.floor(validFromMs / 1000) + 60)
    .changeAddress(myAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log("Withdraw submitted. Tx:", txHash);
}

export async function reclaim(
  walletFile: string,
  beneficiaryVkh: string,
  goal: number,
  deadlineMs: number,
) {
  const wallet = loadWallet(walletFile);
  const provider = new KoiosProvider(NETWORK);
  const myAddr = await wallet.getChangeAddress();
  const myVkh = resolvePaymentKeyHash(myAddr);

  const { script, scriptAddress } = loadValidator(
    beneficiaryVkh,
    BigInt(goal),
    BigInt(deadlineMs),
  );

  const utxo = await findScriptUtxo(provider, scriptAddress);
  const wallets = decodeDatum(utxo.output.plutusData!);
  const myDonation = wallets.get(myVkh);
  if (!myDonation) throw new Error("No donation recorded for this wallet");

  const lovelaceIn = lovelaceOf(utxo.output.amount);
  const remaining = lovelaceIn - myDonation;

  const newWallets = new Map<string, bigint>();
  for (const [k, v] of wallets) if (k !== myVkh) newWallets.set(k, v);

  const ownUtxos = await provider.fetchAddressUTxOs(myAddr);
  const collateral: UTxO[] = await wallet.getCollateral();
  const validFromMs = Math.max(deadlineMs, Date.now());

  const tx = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    evaluator: provider,
  }).setNetwork(NETWORK);

  let chain = tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address)
    .txInScript(script)
    .txInRedeemerValue(mConStr(2, []), "JSON") // RECLAIM
    .txInInlineDatumPresent()
    .txOut(myAddr, [{ unit: "lovelace", quantity: myDonation.toString() }]);

  if (remaining > 0n) {
    chain = chain
      .txOut(scriptAddress, [{ unit: "lovelace", quantity: remaining.toString() }])
      .txOutInlineDatumValue(encodeDatum(newWallets), "JSON");
  }

  await chain
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(myVkh)
    .invalidBefore(Math.floor(validFromMs / 1000))
    .invalidHereafter(Math.floor(validFromMs / 1000) + 60)
    .changeAddress(myAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();

  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log("Reclaim submitted. Tx:", txHash);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  try {
    if (cmd === "init") {
      if (args.length !== 5) {
        throw new Error("Usage: init <wallet> <beneficiary_vkh> <goal_lovelace> <deadline_ms> <amount_lovelace>");
      }
      await init(args[0], args[1], Number(args[2]), Number(args[3]), Number(args[4]));
    } else if (cmd === "donate") {
      if (args.length !== 5) {
        throw new Error("Usage: donate <wallet> <beneficiary_vkh> <goal_lovelace> <deadline_ms> <amount_lovelace>");
      }
      await donate(args[0], args[1], Number(args[2]), Number(args[3]), Number(args[4]));
    } else if (cmd === "withdraw") {
      if (args.length !== 4) {
        throw new Error("Usage: withdraw <wallet> <beneficiary_vkh> <goal_lovelace> <deadline_ms>");
      }
      await withdraw(args[0], args[1], Number(args[2]), Number(args[3]));
    } else if (cmd === "reclaim") {
      if (args.length !== 4) {
        throw new Error("Usage: reclaim <wallet> <beneficiary_vkh> <goal_lovelace> <deadline_ms>");
      }
      await reclaim(args[0], args[1], Number(args[2]), Number(args[3]));
    } else {
      console.log(
        "Usage:\n" +
          "  init <wallet> <beneficiary_vkh> <goal_lovelace> <deadline_ms> <amount_lovelace>\n" +
          "  donate <wallet> <beneficiary_vkh> <goal_lovelace> <deadline_ms> <amount_lovelace>\n" +
          "  withdraw <wallet> <beneficiary_vkh> <goal_lovelace> <deadline_ms>\n" +
          "  reclaim <wallet> <beneficiary_vkh> <goal_lovelace> <deadline_ms>\n",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
}
