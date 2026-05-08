import {
  Lucid,
  Koios,
  applyParamsToScript,
  Constr,
  Data,
  generateSeedPhrase,
  paymentCredentialOf,
  validatorToAddress,
  type LucidEvolution,
  type Script,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Crowdfund — Evolution SDK port.
//
// Validator parameters: (beneficiary: VKH, goal: Int (lovelace), deadline: Int (ms))
// Datum: CrowdfundDatum { wallets: Pairs<VKH, Int> }
//        encoded as Constr 0 [Map<bytes, int>]
// Redeemers:
//   DONATE   = Constr 0 []
//   WITHDRAW = Constr 1 []
//   RECLAIM  = Constr 2 []
//
// Operations:
//   prepare    generate wallet.json
//   init       owner seeds the campaign with first contribution
//   donate     adds contribution from the donor wallet, updating the wallets map
//   withdraw   beneficiary collects all funds after deadline (only if goal reached)
//   reclaim    donor recovers their contribution after deadline (only if goal not reached)
// ----------------------------------------------------------------------------

const KOIOS_URL = "https://preprod.koios.rest/api/v1";

function selectWallet(lucid: LucidEvolution, fileName = "wallet.json") {
  const mnemonic = JSON.parse(Deno.readTextFileSync(fileName));
  lucid.selectWallet.fromSeed(
    Array.isArray(mnemonic) ? mnemonic.join(" ") : mnemonic,
  );
}

async function prepare(fileName: string) {
  try {
    await Deno.stat(fileName);
    console.log(`${fileName} already exists, skipping.`);
    return;
  } catch { /* not found */ }

  const mnemonic = generateSeedPhrase();
  await Deno.writeTextFile(fileName, JSON.stringify(mnemonic.split(" ")));
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  lucid.selectWallet.fromSeed(mnemonic);
  console.log(`Generated ${fileName}. Address: ${await lucid.wallet().address()}`);
}

function loadValidator(beneficiaryVkh: string, goal: bigint, deadlineMs: bigint): {
  validator: Script;
  scriptAddress: string;
} {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(compiled, [beneficiaryVkh, goal, deadlineMs]);
  const validator: Script = { type: "PlutusV3", script };
  return { validator, scriptAddress: validatorToAddress("Preprod", validator) };
}

// Datum is Constr 0 [Map<bytes, int>] — represent the inner map as a JS Map.
function encodeDatum(wallets: Map<string, bigint>): string {
  return Data.to(new Constr(0, [wallets]));
}

function decodeDatum(datumHex: string): Map<string, bigint> {
  const c = Data.from(datumHex) as Constr<Data>;
  return c.fields[0] as Map<string, bigint>;
}

export async function init(
  walletFile: string,
  beneficiaryVkh: string,
  goal: number,
  deadlineMs: number,
  contributionLovelace: number,
) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid, walletFile);
  const myAddr = await lucid.wallet().address();
  const myVkh = paymentCredentialOf(myAddr).hash;

  const { scriptAddress } = loadValidator(beneficiaryVkh, BigInt(goal), BigInt(deadlineMs));

  const wallets = new Map<string, bigint>();
  wallets.set(myVkh, BigInt(contributionLovelace));
  const datum = encodeDatum(wallets);

  const tx = await lucid
    .newTx()
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: datum },
      { lovelace: BigInt(contributionLovelace) },
    )
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Crowdfund initialised");
  console.log("Script address:", scriptAddress);
  console.log("Tx:", txHash);
}

export async function donate(
  walletFile: string,
  beneficiaryVkh: string,
  goal: number,
  deadlineMs: number,
  amountLovelace: number,
) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid, walletFile);
  const myAddr = await lucid.wallet().address();
  const myVkh = paymentCredentialOf(myAddr).hash;

  const { validator, scriptAddress } = loadValidator(
    beneficiaryVkh,
    BigInt(goal),
    BigInt(deadlineMs),
  );

  const utxos = await lucid.utxosAt(scriptAddress);
  const utxo = utxos.find((u) => u.datum);
  if (!utxo) throw new Error("No script UTxO with datum found");

  const wallets = decodeDatum(utxo.datum!);
  const prev = wallets.get(myVkh) ?? 0n;
  wallets.set(myVkh, prev + BigInt(amountLovelace));

  const newDatum = encodeDatum(wallets);
  const newLovelace = (utxo.assets.lovelace ?? 0n) + BigInt(amountLovelace);

  const tx = await lucid
    .newTx()
    .collectFrom([utxo], Data.to(new Constr(0, []))) // DONATE
    .attach.SpendingValidator(validator)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: newDatum },
      { lovelace: newLovelace },
    )
    .addSigner(myAddr)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Donation submitted. Tx:", txHash);
}

export async function withdraw(
  walletFile: string,
  beneficiaryVkh: string,
  goal: number,
  deadlineMs: number,
) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid, walletFile);
  const myAddr = await lucid.wallet().address();
  const myVkh = paymentCredentialOf(myAddr).hash;
  if (myVkh !== beneficiaryVkh) {
    throw new Error("Withdraw must be signed by the beneficiary's wallet");
  }

  const { validator, scriptAddress } = loadValidator(
    beneficiaryVkh,
    BigInt(goal),
    BigInt(deadlineMs),
  );

  const utxos = await lucid.utxosAt(scriptAddress);
  const utxo = utxos.find((u) => u.datum);
  if (!utxo) throw new Error("No script UTxO with datum found");

  const lovelaceIn = utxo.assets.lovelace ?? 0n;
  const now = Date.now();

  const tx = await lucid
    .newTx()
    .collectFrom([utxo], Data.to(new Constr(1, []))) // WITHDRAW
    .attach.SpendingValidator(validator)
    .pay.ToAddress(myAddr, { lovelace: lovelaceIn })
    .addSigner(myAddr)
    .validFrom(Math.max(deadlineMs, now))
    .validTo(Math.max(deadlineMs, now) + 60_000)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Withdraw submitted. Tx:", txHash);
}

export async function reclaim(
  walletFile: string,
  beneficiaryVkh: string,
  goal: number,
  deadlineMs: number,
) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid, walletFile);
  const myAddr = await lucid.wallet().address();
  const myVkh = paymentCredentialOf(myAddr).hash;

  const { validator, scriptAddress } = loadValidator(
    beneficiaryVkh,
    BigInt(goal),
    BigInt(deadlineMs),
  );

  const utxos = await lucid.utxosAt(scriptAddress);
  const utxo = utxos.find((u) => u.datum);
  if (!utxo) throw new Error("No script UTxO with datum found");

  const wallets = decodeDatum(utxo.datum!);
  const myDonation = wallets.get(myVkh);
  if (!myDonation) throw new Error("No donation recorded for this wallet");

  const lovelaceIn = utxo.assets.lovelace ?? 0n;
  const remaining = lovelaceIn - myDonation;

  // Build the updated wallets map with this donor removed.
  const newWallets = new Map<string, bigint>();
  for (const [k, v] of wallets) {
    if (k !== myVkh) newWallets.set(k, v);
  }

  const txBuilder = lucid
    .newTx()
    .collectFrom([utxo], Data.to(new Constr(2, []))) // RECLAIM
    .attach.SpendingValidator(validator)
    .pay.ToAddress(myAddr, { lovelace: myDonation })
    .addSigner(myAddr)
    .validFrom(Math.max(deadlineMs, Date.now()))
    .validTo(Math.max(deadlineMs, Date.now()) + 60_000);

  // If donors remain, continue the script UTxO with reduced lovelace and updated map.
  const finalTx = remaining > 0n
    ? txBuilder.pay.ToContract(
      scriptAddress,
      { kind: "inline", value: encodeDatum(newWallets) },
      { lovelace: remaining },
    )
    : txBuilder;

  const tx = await finalTx.complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Reclaim submitted. Tx:", txHash);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  try {
    if (cmd === "prepare") {
      if (!args[0]) throw new Error("Usage: prepare <wallet.json>");
      await prepare(args[0]);
    } else if (cmd === "init") {
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
          "  prepare <wallet.json>\n" +
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
