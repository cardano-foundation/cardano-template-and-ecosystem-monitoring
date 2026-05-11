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
// Vesting. Single PlutusV3 spend validator: owner signature short-circuits
// (early reclaim); beneficiary signature requires valid_after(lock_until).
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
  return getAddressDetails(await l.wallet().address()).paymentCredential!.hash;
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

function loadValidator(): { validator: Validator; scriptAddress: string } {
  const script = applyParamsToScript(blueprint.validators[0].compiledCode, []);
  const validator: Validator = { type: "PlutusV3", script };
  return { validator, scriptAddress: validatorToAddress(NETWORK, validator) };
}

async function yaciTipSlot(): Promise<number> {
  return (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot;
}

function slotToMs(slot: number): number {
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  return cfg.zeroTime + (slot - cfg.zeroSlot) * cfg.slotLength;
}

async function deposit(
  ownerLucid: LucidEvolution,
  ownerVkh: string,
  beneficiaryVkh: string,
  lovelace: bigint,
  lockUntilMs: number,
): Promise<string> {
  const { scriptAddress } = loadValidator();
  const datum = Data.to(
    new Constr(0, [BigInt(lockUntilMs), ownerVkh, beneficiaryVkh]),
  );
  const tx = await ownerLucid
    .newTx()
    .pay.ToContract(scriptAddress, { kind: "inline", value: datum }, { lovelace })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`DEPOSIT ok. lockUntilMs=${lockUntilMs} tx=${txHash}`);
  return txHash;
}

async function findVestingUtxo(
  lucid: LucidEvolution,
  txHash: string,
): Promise<{ assets: Record<string, bigint>; datum: string } & object> {
  for (let i = 0; i < 60; i++) {
    try {
      const utxos = await lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]);
      if (utxos.length > 0 && utxos[0].datum) return utxos[0] as never;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Vesting UTxO ${txHash}#0 not found`);
}

async function withdrawAsOwner(
  ownerLucid: LucidEvolution,
  utxo: { datum: string },
) {
  const { validator } = loadValidator();
  const ownerAddr = await ownerLucid.wallet().address();
  const tx = await ownerLucid
    .newTx()
    .collectFrom([utxo as never], Data.to(new Constr(0, [])))
    .attach.SpendingValidator(validator)
    .addSigner(ownerAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`WITHDRAW (owner) ok. tx=${txHash}`);
}

async function withdrawAsBeneficiary(
  benLucid: LucidEvolution,
  utxo: { datum: string },
  lockUntilMs: number,
) {
  const { validator } = loadValidator();
  const benAddr = await benLucid.wallet().address();
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const lockUntilSlot = Math.floor((lockUntilMs - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const tipSlot = await yaciTipSlot();
  const validFromSlot = Math.max(lockUntilSlot + 1, tipSlot - 5);
  const validToSlot = validFromSlot + 120;
  const tx = await benLucid
    .newTx()
    .collectFrom([utxo as never], Data.to(new Constr(0, [])))
    .attach.SpendingValidator(validator)
    .addSigner(benAddr)
    .validFrom(slotToMs(validFromSlot))
    .validTo(slotToMs(validToSlot))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`WITHDRAW (beneficiary) ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== vesting scenario: deposit×2 → owner-withdraw / beneficiary-withdraw ===");
  await alignSlotConfig();

  // account 0 = owner / funder ; 1 = beneficiary
  const owner = await lucidAt(0);
  const ownerVkh = await vkhOf(0);
  const ben = await lucidAt(1);
  const benVkh = await vkhOf(1);
  const benAddr = await ben.wallet().address();
  await fundFromIndex0([{ address: benAddr, lovelace: 20_000_000n }]);

  const lockUntilFar = Date.now() + 60 * 60 * 1000;
  const tx1 = await deposit(owner, ownerVkh, benVkh, 5_000_000n, lockUntilFar);
  await waitForUtxosAt(owner, await owner.wallet().address(), 1, 60);
  await new Promise((r) => setTimeout(r, 2000));

  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const tipSlot = await yaciTipSlot();
  const lockUntilShort = slotToMs(tipSlot + 10);
  const tx2 = await deposit(owner, ownerVkh, benVkh, 5_000_000n, lockUntilShort);
  await new Promise((r) => setTimeout(r, 2000));

  const u1 = await findVestingUtxo(owner, tx1);
  await withdrawAsOwner(owner, u1);

  const lockSlot = Math.floor((lockUntilShort - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > lockSlot) {
      console.log(`tipSlot ${tip} > lockUntilSlot ${lockSlot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${lockSlot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const u2 = await findVestingUtxo(ben, tx2);
  await withdrawAsBeneficiary(ben, u2, lockUntilShort);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
