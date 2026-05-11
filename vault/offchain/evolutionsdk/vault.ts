import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  applyParamsToScript,
  getAddressDetails,
  validatorToAddress,
  type LucidEvolution,
  type Validator,
} from "@evolution-sdk/lucid";
import { SLOT_CONFIG_NETWORK } from "@evolution-sdk/plutus";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Vault — Evolution SDK targeting yaci-devkit.
// Validator params (owner_vkh, wait_time_ms).
// Spend redeemers: WITHDRAW | FINALIZE | CANCEL. Scenario exercises ALL three.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preview" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const WAIT_TIME = 10_000n; // 10 seconds — short enough to exercise FINALIZE.
const ERA_OFFSET_SECONDS = 600;

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

async function yaciTipSlot(): Promise<number> {
  return (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot;
}
function slotToMs(slot: number): number {
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  return cfg.zeroTime + (slot - cfg.zeroSlot) * cfg.slotLength;
}

async function setup() {
  const lucid = await lucidAt(0);
  const address = await lucid.wallet().address();
  const ownerVkh = getAddressDetails(address).paymentCredential!.hash;
  const script = applyParamsToScript(blueprint.validators[0].compiledCode, [
    ownerVkh,
    WAIT_TIME,
  ]);
  const validator: Validator = { type: "PlutusV3", script };
  return { lucid, validator, scriptAddress: validatorToAddress(NETWORK, validator), address };
}

async function lock(amount: bigint, lockInfinite: boolean): Promise<string> {
  const { lucid, scriptAddress } = await setup();
  const lockTime = lockInfinite
    ? BigInt(Date.now() + 365 * 24 * 60 * 60 * 1000)
    : BigInt(Date.now() - 60_000);
  const datum = Data.to(new Constr(0, [lockTime]));
  const tx = await lucid
    .newTx()
    .pay.ToContract(scriptAddress, { kind: "inline", value: datum }, { lovelace: amount })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`LOCK${lockInfinite ? " (infinite)" : " (withdrawable)"} ok. tx=${txHash}`);
  return txHash;
}

async function findScriptUtxo(lucid: LucidEvolution, scriptAddress: string, txHash: string) {
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(scriptAddress);
    const u = utxos.find((x) => x.txHash === txHash);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`UTxO ${txHash} not found at ${scriptAddress}`);
}

async function withdraw(txHash: string): Promise<string> {
  const { lucid, validator, scriptAddress, address } = await setup();
  const utxo = await findScriptUtxo(lucid, scriptAddress, txHash);
  // Validator requires `valid_after(validity_range, lock_time)`, i.e.
  // validFrom > lock_time. Set lock_time just before validFrom so the predicate
  // holds while keeping the cooldown anchor close to "now".
  const tipSlot = await yaciTipSlot();
  const validFromSlot = tipSlot - 5;
  const lockTime = BigInt(slotToMs(validFromSlot - 5));
  const newDatum = Data.to(new Constr(0, [lockTime]));
  const redeemer = Data.to(new Constr(0, []));
  const tx = await lucid
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .pay.ToContract(scriptAddress, { kind: "inline", value: newDatum }, utxo.assets)
    .addSigner(address)
    .validFrom(slotToMs(validFromSlot))
    .validTo(slotToMs(tipSlot + 60))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const subHash = await signed.submit();
  console.log(`WITHDRAW ok. new lockTime=${lockTime} tx=${subHash}`);
  return subHash;
}

async function finalize(txHash: string): Promise<string> {
  const { lucid, validator, scriptAddress, address } = await setup();
  const utxo = await findScriptUtxo(lucid, scriptAddress, txHash);
  if (!utxo.datum) throw new Error("No datum");
  const d = Data.from(utxo.datum) as Constr<bigint>;
  const lockTime = d.fields[0] as bigint;
  const validAfterMs = Number(lockTime + WAIT_TIME);
  // Wait until chain slot > validAfter.
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const validAfterSlot = Math.floor((validAfterMs - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > validAfterSlot) break;
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${validAfterSlot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tipSlot = await yaciTipSlot();
  const validFromSlot = Math.max(validAfterSlot + 1, tipSlot - 5);
  const redeemer = Data.to(new Constr(1, []));
  const tx = await lucid
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .addSigner(address)
    .validFrom(slotToMs(validFromSlot))
    .validTo(slotToMs(validFromSlot + 60))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const subHash = await signed.submit();
  console.log(`FINALIZE ok. tx=${subHash}`);
  return subHash;
}

async function cancel(txHash: string): Promise<string> {
  const { lucid, validator, scriptAddress, address } = await setup();
  const utxo = await findScriptUtxo(lucid, scriptAddress, txHash);
  const redeemer = Data.to(new Constr(2, []));
  // CANCEL requires output back to script with same lovelace, NoDatum.
  const tx = await lucid
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .pay.ToAddress(scriptAddress, utxo.assets)
    .addSigner(address)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const subHash = await signed.submit();
  console.log(`CANCEL ok. tx=${subHash}`);
  return subHash;
}

async function runScenario() {
  console.log("=== vault scenario: lock×2 → withdraw → cancel (first lock) ; withdraw → finalize (second lock) ===");
  await alignSlotConfig();

  // Lock A: long-locked deposit we'll start a withdraw on then CANCEL.
  const txA = await lock(8_000_000n, true);
  await new Promise((r) => setTimeout(r, 2000));
  // Lock B: long-locked deposit we'll withdraw and FINALIZE.
  const txB = await lock(6_000_000n, true);
  await new Promise((r) => setTimeout(r, 2000));

  // Start withdraw on A then cancel back to script.
  const txA2 = await withdraw(txA);
  await new Promise((r) => setTimeout(r, 2000));
  await cancel(txA2);
  await new Promise((r) => setTimeout(r, 2000));

  // Withdraw → finalize on B.
  const txB2 = await withdraw(txB);
  await new Promise((r) => setTimeout(r, 2000));
  await finalize(txB2);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
