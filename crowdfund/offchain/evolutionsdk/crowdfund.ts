import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  applyParamsToScript,
  paymentCredentialOf,
  validatorToAddress,
  type LucidEvolution,
  type Script,
} from "@evolution-sdk/lucid";
import { SLOT_CONFIG_NETWORK } from "@evolution-sdk/plutus";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Crowdfund. Parameterised PlutusV3 validator (beneficiary_vkh, goal,
// deadline_ms) with Donate / Withdraw / Reclaim redeemers. Withdraw and
// Reclaim both demand valid_after(deadline), so the scenario blocks until
// the chain tip rolls past the deadline before submitting.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preview" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ERA_OFFSET_SECONDS = 600;

// yaci-devkit boots through several "instant" eras and enters Babbage at
// relative slot/time 600s, so TxInfo POSIX = (systemStart + 600 + slot) * 1000.
// We pre-bake that offset in SLOT_CONFIG_NETWORK so validFrom(Date.now())
// round-trips against the validator's view of time.
async function alignSlotConfig() {
  const block = await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json());
  const zeroTime = (block.time - block.slot + ERA_OFFSET_SECONDS) * 1000;
  SLOT_CONFIG_NETWORK.Preview.zeroTime = zeroTime;
  SLOT_CONFIG_NETWORK.Preview.zeroSlot = 0;
  SLOT_CONFIG_NETWORK.Preview.slotLength = 1000;
}

async function lucidAt(accountIndex: number): Promise<LucidEvolution> {
  const lucid = await Lucid(new Blockfrost(YACI_URL, "Dummy Key"), NETWORK);
  lucid.selectWallet.fromSeed(TEST_MNEMONIC, { accountIndex });
  return lucid;
}

async function vkhOf(accountIndex: number): Promise<string> {
  const l = await lucidAt(accountIndex);
  return paymentCredentialOf(await l.wallet().address()).hash;
}

async function yaciTipSlot(): Promise<number> {
  return (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot;
}
function slotToMs(slot: number): number {
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  return cfg.zeroTime + (slot - cfg.zeroSlot) * cfg.slotLength;
}

function loadValidator(beneficiaryVkh: string, goal: bigint, deadlineMs: bigint) {
  const script = applyParamsToScript(blueprint.validators[0].compiledCode, [
    beneficiaryVkh,
    goal,
    deadlineMs,
  ]);
  const validator: Script = { type: "PlutusV3", script };
  return { validator, scriptAddress: validatorToAddress(NETWORK, validator) };
}

function encodeDatum(wallets: Map<string, bigint>): string {
  return Data.to(new Constr(0, [wallets]));
}
function decodeDatum(datumHex: string): Map<string, bigint> {
  const c = Data.from(datumHex) as Constr<Data>;
  return c.fields[0] as Map<string, bigint>;
}

async function findScriptUtxo(lucid: LucidEvolution, scriptAddress: string) {
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(scriptAddress);
    const u = utxos.find((x) => x.datum);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`No script UTxO with datum at ${scriptAddress}`);
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

async function initCampaign(
  ownerLucid: LucidEvolution,
  ownerVkh: string,
  beneficiaryVkh: string,
  goal: bigint,
  deadlineMs: bigint,
  contribution: bigint,
): Promise<string> {
  const { scriptAddress } = loadValidator(beneficiaryVkh, goal, deadlineMs);
  const wallets = new Map<string, bigint>();
  wallets.set(ownerVkh, contribution);
  const tx = await ownerLucid
    .newTx()
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: encodeDatum(wallets) },
      { lovelace: contribution },
    )
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`INIT ok. ${contribution} lovelace tx=${txHash}`);
  return txHash;
}

async function donate(
  donorLucid: LucidEvolution,
  donorVkh: string,
  beneficiaryVkh: string,
  goal: bigint,
  deadlineMs: bigint,
  amount: bigint,
) {
  const donorAddr = await donorLucid.wallet().address();
  const { validator, scriptAddress } = loadValidator(beneficiaryVkh, goal, deadlineMs);
  const utxo = await findScriptUtxo(donorLucid, scriptAddress);
  const wallets = decodeDatum(utxo.datum!);
  wallets.set(donorVkh, (wallets.get(donorVkh) ?? 0n) + amount);
  const newLovelace = (utxo.assets.lovelace ?? 0n) + amount;
  const tx = await donorLucid
    .newTx()
    .collectFrom([utxo], Data.to(new Constr(0, [])))
    .attach.SpendingValidator(validator)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: encodeDatum(wallets) },
      { lovelace: newLovelace },
    )
    .addSigner(donorAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`DONATE ok. +${amount} from donor tx=${txHash}`);
}

async function withdraw(
  beneficiaryLucid: LucidEvolution,
  beneficiaryVkh: string,
  goal: bigint,
  deadlineMs: bigint,
) {
  const benAddr = await beneficiaryLucid.wallet().address();
  const { validator, scriptAddress } = loadValidator(beneficiaryVkh, goal, deadlineMs);
  const utxo = await findScriptUtxo(beneficiaryLucid, scriptAddress);

  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const deadlineSlot = Math.floor((Number(deadlineMs) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const tipSlot = await yaciTipSlot();
  const validFromSlot = Math.max(deadlineSlot + 1, tipSlot - 5);

  const tx = await beneficiaryLucid
    .newTx()
    .collectFrom([utxo], Data.to(new Constr(1, [])))
    .attach.SpendingValidator(validator)
    .addSigner(benAddr)
    .validFrom(slotToMs(validFromSlot))
    .validTo(slotToMs(validFromSlot + 120))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`WITHDRAW ok. tx=${txHash}`);
}

async function reclaim(
  donorLucid: LucidEvolution,
  donorVkh: string,
  beneficiaryVkh: string,
  goal: bigint,
  deadlineMs: bigint,
) {
  const donorAddr = await donorLucid.wallet().address();
  const { validator, scriptAddress } = loadValidator(beneficiaryVkh, goal, deadlineMs);
  const utxo = await findScriptUtxo(donorLucid, scriptAddress);
  const wallets = decodeDatum(utxo.datum!);
  const myDonation = wallets.get(donorVkh);
  if (!myDonation) throw new Error("No donation recorded");

  const lovelaceIn = utxo.assets.lovelace ?? 0n;
  const remaining = lovelaceIn - myDonation;
  const newWallets = new Map<string, bigint>();
  for (const [k, v] of wallets) if (k !== donorVkh) newWallets.set(k, v);

  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const deadlineSlot = Math.floor((Number(deadlineMs) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const tipSlot = await yaciTipSlot();
  const validFromSlot = Math.max(deadlineSlot + 1, tipSlot - 5);

  let txb = donorLucid
    .newTx()
    .collectFrom([utxo], Data.to(new Constr(2, [])))
    .attach.SpendingValidator(validator)
    .addSigner(donorAddr)
    .validFrom(slotToMs(validFromSlot))
    .validTo(slotToMs(validFromSlot + 120));
  if (remaining > 0n) {
    // Partial reclaim: validator destructures continuing datum as
    // Some(CrowdfundDatum), so the on-chain shape is Constr 0 [datum].
    const continuingDatum = Data.to(new Constr(0, [new Constr(0, [newWallets])]));
    txb = txb.pay.ToContract(
      scriptAddress,
      { kind: "inline", value: continuingDatum },
      { lovelace: remaining },
    );
  }
  const tx = await txb.complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`RECLAIM ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== crowdfund scenario: init → donate → withdraw (goal-reached path); separate campaign for reclaim ===");
  await alignSlotConfig();

  // account 0 = owner / funder ; 1 = beneficiary ; 2 = donor
  const beneficiary = await lucidAt(1);
  const beneficiaryVkh = await vkhOf(1);
  const benAddr = await beneficiary.wallet().address();
  const donor = await lucidAt(2);
  const donorVkh = await vkhOf(2);
  const donorAddr = await donor.wallet().address();
  await fundFromIndex0([
    { address: benAddr, lovelace: 30_000_000n },
    { address: donorAddr, lovelace: 30_000_000n },
  ]);

  // Campaign 1 exercises the goal-reached Withdraw path.
  const goal1 = 10_000_000n;
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  let tipSlot = await yaciTipSlot();
  const deadline1Slot = tipSlot + 15;
  const deadline1Ms = BigInt(slotToMs(deadline1Slot));
  const owner = await lucidAt(0);
  const ownerVkh = await vkhOf(0);
  await initCampaign(owner, ownerVkh, beneficiaryVkh, goal1, deadline1Ms, 6_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await donate(donor, donorVkh, beneficiaryVkh, goal1, deadline1Ms, 5_000_000n);
  await new Promise((r) => setTimeout(r, 2000));

  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > deadline1Slot) {
      console.log(`tipSlot ${tip} > deadline1Slot ${deadline1Slot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${deadline1Slot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await withdraw(beneficiary, beneficiaryVkh, goal1, deadline1Ms);

  // Campaign 2 exercises the goal-not-reached Reclaim path.
  const goal2 = 100_000_000n;
  tipSlot = await yaciTipSlot();
  const deadline2Slot = tipSlot + 15;
  const deadline2Ms = BigInt(slotToMs(deadline2Slot));
  await initCampaign(owner, ownerVkh, beneficiaryVkh, goal2, deadline2Ms, 5_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await donate(donor, donorVkh, beneficiaryVkh, goal2, deadline2Ms, 4_000_000n);
  await new Promise((r) => setTimeout(r, 2000));

  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > deadline2Slot) {
      console.log(`tipSlot ${tip} > deadline2Slot ${deadline2Slot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${deadline2Slot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await reclaim(donor, donorVkh, beneficiaryVkh, goal2, deadline2Ms);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
