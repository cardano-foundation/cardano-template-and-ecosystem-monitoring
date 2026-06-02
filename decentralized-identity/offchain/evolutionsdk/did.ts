import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  generateSeedPhrase,
  getAddressDetails,
  validatorToAddress,
  type LucidEvolution,
  type Validator,
} from "@evolution-sdk/lucid";
import { SLOT_CONFIG_NETWORK } from "@evolution-sdk/plutus";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// ----------------------------------------------------------------------------
// Decentralised identity. Single PlutusV3 spend validator exercising the
// TransferOwner / AddDelegate / RemoveDelegate redeemers. AddDelegate has
// a valid_before(expires) constraint, so its validity range is shrunk to
// land before the delegate's expiration.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preview" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ERA_OFFSET_SECONDS = 600;

const DelegateSchema = Data.Object({
  key: Data.Bytes(),
  expires: Data.Integer(),
});
const IdentityDatumSchema = Data.Object({
  owner: Data.Bytes(),
  delegates: Data.Array(DelegateSchema),
});
type IdentityDatum = Data.Static<typeof IdentityDatumSchema>;
const IdentityDatum = IdentityDatumSchema as unknown as IdentityDatum;

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
async function lucidFromSeed(seed: string): Promise<LucidEvolution> {
  const lucid = await Lucid(new Blockfrost(YACI_URL, "Dummy Key"), NETWORK);
  lucid.selectWallet.fromSeed(seed);
  return lucid;
}

async function yaciTipSlot(): Promise<number> {
  return (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot;
}
function slotToMs(slot: number): number {
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  return cfg.zeroTime + (slot - cfg.zeroSlot) * cfg.slotLength;
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

async function fundFromIndex0(targetAddress: string, lovelace: bigint) {
  const lucid = await lucidAt(0);
  const tx = await lucid.newTx().pay.ToAddress(targetAddress, { lovelace }).complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Funded ${targetAddress.slice(0, 20)}… with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxosAt(lucid, targetAddress, 1, 60);
  await new Promise((r) => setTimeout(r, 2000));
}

function setup() {
  const v = blueprint.validators.find((x) => x.title === "identity.identity.spend");
  if (!v) throw new Error("Validator not found");
  const validator: Validator = { type: "PlutusV3", script: v.compiledCode };
  return { validator, scriptAddress: validatorToAddress(NETWORK, validator) };
}

async function init(owner: LucidEvolution, lovelace: bigint): Promise<string> {
  const { scriptAddress } = setup();
  const ownerAddr = await owner.wallet().address();
  const ownerVkh = getAddressDetails(ownerAddr).paymentCredential!.hash;
  const datum = Data.to({ owner: ownerVkh, delegates: [] }, IdentityDatum);

  const tx = await owner
    .newTx()
    .pay.ToContract(scriptAddress, { kind: "inline", value: datum }, { lovelace })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`INIT ok. tx=${txHash}`);
  return txHash;
}

async function loadIdentity(lucid: LucidEvolution, txHash: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const utxos = await lucid.utxosByOutRef([{ txHash, outputIndex: 0 }]);
      if (utxos.length > 0 && utxos[0].datum) {
        const state = Data.from(utxos[0].datum, IdentityDatum) as unknown as IdentityDatum;
        return { utxo: utxos[0], state };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Identity UTxO ${txHash}#0 not found`);
}

async function addDelegate(
  owner: LucidEvolution,
  delegateVkh: string,
  expiresMs: bigint,
  prevTxHash: string,
): Promise<string> {
  const { validator, scriptAddress } = setup();
  const { utxo, state } = await loadIdentity(owner, prevTxHash);
  const updated = {
    owner: state.owner,
    delegates: [...state.delegates, { key: delegateVkh, expires: expiresMs }],
  };
  const redeemer = Data.to(new Constr(1, [delegateVkh, expiresMs]));

  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const expiresSlot = Math.floor((Number(expiresMs) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const tipSlot = await yaciTipSlot();
  const validToSlot = Math.min(tipSlot + 10, expiresSlot - 5);

  const tx = await owner
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], redeemer)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.to(updated, IdentityDatum) },
      utxo.assets,
    )
    .addSigner(await owner.wallet().address())
    .validFrom(slotToMs(tipSlot - 5))
    .validTo(slotToMs(validToSlot))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`ADD_DELEGATE ok. tx=${txHash}`);
  return txHash;
}

async function removeDelegate(
  owner: LucidEvolution,
  delegateVkh: string,
  prevTxHash: string,
): Promise<string> {
  const { validator, scriptAddress } = setup();
  const { utxo, state } = await loadIdentity(owner, prevTxHash);
  const updated = {
    owner: state.owner,
    delegates: state.delegates.filter((d) => d.key !== delegateVkh),
  };
  const redeemer = Data.to(new Constr(2, [delegateVkh]));

  const tx = await owner
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], redeemer)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.to(updated, IdentityDatum) },
      utxo.assets,
    )
    .addSigner(await owner.wallet().address())
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`REMOVE_DELEGATE ok. tx=${txHash}`);
  return txHash;
}

async function transferOwner(
  currentOwner: LucidEvolution,
  newOwnerVkh: string,
  prevTxHash: string,
): Promise<string> {
  const { validator, scriptAddress } = setup();
  const { utxo, state } = await loadIdentity(currentOwner, prevTxHash);
  const updated = { owner: newOwnerVkh, delegates: state.delegates };
  const redeemer = Data.to(new Constr(0, [newOwnerVkh]));

  const tx = await currentOwner
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], redeemer)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.to(updated, IdentityDatum) },
      utxo.assets,
    )
    .addSigner(await currentOwner.wallet().address())
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`TRANSFER_OWNER ok. tx=${txHash}`);
  return txHash;
}

async function runScenario() {
  console.log("=== did scenario: init → add-delegate → remove-delegate → transfer-owner ===");
  await alignSlotConfig();

  // owner = fresh seed (so the run is repeatable); account 1 = delegate;
  // account 2 = next owner for the final TransferOwner step.
  const ownerSeed = generateSeedPhrase();
  const owner = await lucidFromSeed(ownerSeed);
  const ownerAddr = await owner.wallet().address();
  await fundFromIndex0(ownerAddr, 30_000_000n);

  const delegate = await lucidAt(1);
  const delegateVkh = getAddressDetails(await delegate.wallet().address()).paymentCredential!.hash;
  const newOwner = await lucidAt(2);
  const newOwnerVkh = getAddressDetails(await newOwner.wallet().address()).paymentCredential!.hash;

  const initTx = await init(owner, 3_000_000n);
  await new Promise((r) => setTimeout(r, 2000));

  const expiresMs = BigInt(Date.now() + 24 * 60 * 60 * 1000);
  const addTx = await addDelegate(owner, delegateVkh, expiresMs, initTx);
  await new Promise((r) => setTimeout(r, 2000));

  const remTx = await removeDelegate(owner, delegateVkh, addTx);
  await new Promise((r) => setTimeout(r, 2000));

  await transferOwner(owner, newOwnerVkh, remTx);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
