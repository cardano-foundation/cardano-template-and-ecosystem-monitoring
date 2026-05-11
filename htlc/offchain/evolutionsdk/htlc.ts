import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  applyParamsToScript,
  fromText,
  getAddressDetails,
  validatorToAddress,
  type LucidEvolution,
  type Validator,
} from "@evolution-sdk/lucid";
import { SLOT_CONFIG_NETWORK } from "@evolution-sdk/plutus";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Hashed Timelock Contract. Parameterised PlutusV3 spend validator
// (secret_hash, expiration_ms, owner_vkh). Guess (pre-image reveal) wins
// before expiry; Withdraw (owner refund) requires valid_after(expiration).
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

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function loadValidator(
  secretHashHex: string,
  expirationMs: bigint,
  ownerVkh: string,
): { validator: Validator; scriptAddress: string } {
  const script = applyParamsToScript(blueprint.validators[0].compiledCode, [
    secretHashHex,
    expirationMs,
    ownerVkh,
  ]);
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

async function init(
  owner: LucidEvolution,
  secret: string,
  ownerVkh: string,
  expirationMs: bigint,
  lovelace: bigint,
): Promise<{ txHash: string; secretHashHex: string }> {
  const secretHashHex = await sha256Hex(secret);
  const { scriptAddress } = loadValidator(secretHashHex, expirationMs, ownerVkh);
  const tx = await owner
    .newTx()
    .pay.ToContract(scriptAddress, { kind: "inline", value: Data.void() }, { lovelace })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`INIT ok. secretHash=${secretHashHex.slice(0, 12)}… tx=${txHash}`);
  return { txHash, secretHashHex };
}

async function findLockedUtxo(
  lucid: LucidEvolution,
  scriptAddress: string,
  initTxHash: string,
) {
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(scriptAddress);
    const u = utxos.find((x) => x.txHash === initTxHash);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Locked UTxO ${initTxHash} not found at ${scriptAddress}`);
}

async function claim(
  claimer: LucidEvolution,
  secret: string,
  secretHashHex: string,
  expirationMs: bigint,
  ownerVkh: string,
  initTxHash: string,
) {
  const { validator, scriptAddress } = loadValidator(secretHashHex, expirationMs, ownerVkh);
  const utxo = await findLockedUtxo(claimer, scriptAddress, initTxHash);
  const answerHex = fromText(secret);
  const redeemer = Data.to(new Constr(0, [answerHex]));
  const tx = await claimer
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], redeemer)
    .addSigner(await claimer.wallet().address())
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`CLAIM ok. tx=${txHash}`);
}

async function refund(
  owner: LucidEvolution,
  secretHashHex: string,
  expirationMs: bigint,
  ownerVkh: string,
  initTxHash: string,
) {
  const { validator, scriptAddress } = loadValidator(secretHashHex, expirationMs, ownerVkh);
  const utxo = await findLockedUtxo(owner, scriptAddress, initTxHash);
  const redeemer = Data.to(new Constr(1, []));
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const expirationSlot = Math.floor((Number(expirationMs) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const tipSlot = await yaciTipSlot();
  const validFromSlot = Math.max(expirationSlot + 1, tipSlot - 5);
  const validToSlot = validFromSlot + 120;
  const tx = await owner
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], redeemer)
    .addSigner(await owner.wallet().address())
    .validFrom(slotToMs(validFromSlot))
    .validTo(slotToMs(validToSlot))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`REFUND ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== htlc scenario: init×2 → claim (correct secret) / refund (after expiry) ===");
  await alignSlotConfig();

  // account 0 = owner / funder ; 1 = claimer
  const owner = await lucidAt(0);
  const claimer = await lucidAt(1);
  const ownerVkh = await vkhOf(0);
  const claimerAddr = await claimer.wallet().address();
  await fundFromIndex0([{ address: claimerAddr, lovelace: 20_000_000n }]);

  const secret1 = "open-sesame";
  const exp1 = BigInt(Date.now() + 60 * 60 * 1000);
  const { txHash: tx1, secretHashHex: h1 } = await init(owner, secret1, ownerVkh, exp1, 10_000_000n);
  await new Promise((r) => setTimeout(r, 2000));

  const secret2 = "another-secret";
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const exp2Slot = (await yaciTipSlot()) + 10;
  const exp2 = BigInt(slotToMs(exp2Slot));
  const { txHash: tx2, secretHashHex: h2 } = await init(owner, secret2, ownerVkh, exp2, 8_000_000n);
  await new Promise((r) => setTimeout(r, 2000));

  await claim(claimer, secret1, h1, exp1, ownerVkh, tx1);

  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > exp2Slot) {
      console.log(`tipSlot ${tip} > exp2Slot ${exp2Slot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${exp2Slot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  await refund(owner, h2, exp2, ownerVkh, tx2);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
