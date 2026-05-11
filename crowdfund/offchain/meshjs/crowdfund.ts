import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  deserializeDatum,
  integer,
  mConStr,
  mConStr0,
  resolvePaymentKeyHash,
  serializePlutusScript,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Crowdfund: parameterized validator (beneficiary, goal, deadline) with a wallets map
// (donor_vkh → lovelace) in the datum. Exercises DONATE / WITHDRAW / RECLAIM end-to-end.
// Mesh quirk: omit `evaluator` so Mesh's CPU estimator is used against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const FUNDER_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

function provider(): BlockfrostProvider {
  return new BlockfrostProvider(YACI_URL);
}
function makeWallet(words: string[]): MeshWallet {
  const p = provider();
  return new MeshWallet({
    networkId: NETWORK_ID,
    fetcher: p,
    submitter: p,
    key: { type: "mnemonic", words },
  });
}
function funderWallet(): MeshWallet {
  return makeWallet(FUNDER_MNEMONIC.split(/\s+/));
}

async function yaciTipSlot(): Promise<number> {
  return (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot;
}
async function yaciSystemStartSec(): Promise<number> {
  const block = await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json());
  return block.time - block.slot + 600;
}
function slotToMs(slot: number, systemStartSec: number): number {
  return (systemStartSec + slot) * 1000;
}

async function waitForUtxoAt(addr: string, minCount = 1, timeoutSec = 60) {
  const p = provider();
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await p.fetchAddressUTxOs(addr);
      if (u.length >= minCount) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${addr}`);
}

async function fundFromFunder(targetAddr: string, lovelace: bigint) {
  const wallet = funderWallet();
  const myAddr = await wallet.getChangeAddress();
  const myUtxos = await provider().fetchAddressUTxOs(myAddr);
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(targetAddr, [{ unit: "lovelace", quantity: lovelace.toString() }])
    .changeAddress(myAddr)
    .selectUtxosFrom(myUtxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Funded ${targetAddr.slice(0, 20)}… with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxoAt(targetAddr, 1);
}

function loadValidator(beneficiaryVkh: string, goal: bigint, deadlineMs: bigint) {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(
    compiled,
    [
      builtinByteString(beneficiaryVkh),
      integer(Number(goal)),
      integer(Number(deadlineMs)),
    ],
    "JSON",
  );
  const { address: scriptAddress } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, scriptAddress };
}

// JSON-shape {constructor,fields} — serializeData / txOutInlineDatumValue("JSON") path.
// Mesh-shape {alternative,fields} would be rejected here.
function buildDatum(wallets: Map<string, bigint>): unknown {
  return {
    constructor: 0,
    fields: [
      { map: [...wallets].map(([k, v]) => ({ k: { bytes: k }, v: { int: Number(v) } })) },
    ],
  };
}
// RECLAIM's continuing datum is wrapped in Some(...) by the validator's pattern match.
function buildSomeDatum(wallets: Map<string, bigint>): unknown {
  return {
    constructor: 0,
    fields: [buildDatum(wallets)],
  };
}

function decodeWallets(datumHex: string): Map<string, bigint> {
  const d = deserializeDatum(datumHex) as {
    fields: Array<{ map?: Array<{ k: { bytes: string }; v: { int: string | number | bigint } }> }>;
  };
  const map = new Map<string, bigint>();
  for (const e of d.fields[0].map ?? []) {
    map.set(e.k.bytes, BigInt(e.v.int));
  }
  return map;
}

async function findScriptUtxo(scriptAddress: string): Promise<UTxO> {
  for (let i = 0; i < 60; i++) {
    const utxos = await provider().fetchAddressUTxOs(scriptAddress);
    const u = utxos.find((x) => x.output.plutusData);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("No script UTxO with datum found");
}

async function initCampaign(
  owner: MeshWallet,
  ownerVkh: string,
  beneficiaryVkh: string,
  goal: bigint,
  deadlineMs: bigint,
  contribution: bigint,
) {
  const ownerAddr = await owner.getChangeAddress();
  const { scriptAddress } = loadValidator(beneficiaryVkh, goal, deadlineMs);
  const wallets = new Map<string, bigint>();
  wallets.set(ownerVkh, contribution);
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: contribution.toString() }])
    .txOutInlineDatumValue(buildDatum(wallets), "JSON")
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`INIT ok. ${contribution} lovelace tx=${txHash}`);
}

async function donate(
  donor: MeshWallet,
  donorVkh: string,
  beneficiaryVkh: string,
  goal: bigint,
  deadlineMs: bigint,
  amount: bigint,
) {
  const donorAddr = await donor.getChangeAddress();
  const { script, scriptAddress } = loadValidator(beneficiaryVkh, goal, deadlineMs);
  const utxo = await findScriptUtxo(scriptAddress);
  if (!utxo.output.plutusData) throw new Error("No datum on script UTxO");
  const wallets = decodeWallets(utxo.output.plutusData);
  wallets.set(donorVkh, (wallets.get(donorVkh) ?? 0n) + amount);
  const lovelaceIn = BigInt(
    utxo.output.amount.find((a) => a.unit === "lovelace")!.quantity,
  );
  const newLovelace = lovelaceIn + amount;

  const ownUtxos = await provider().fetchAddressUTxOs(donorAddr);
  const collateral: UTxO[] = await donor.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr(0, []))
    .txInInlineDatumPresent()
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: newLovelace.toString() }])
    .txOutInlineDatumValue(buildDatum(wallets), "JSON")
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(donorVkh)
    .changeAddress(donorAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await donor.signTx(tx.txHex);
  const txHash = await donor.submitTx(signed);
  console.log(`DONATE ok. +${amount} tx=${txHash}`);
}

async function withdraw(
  beneficiary: MeshWallet,
  beneficiaryVkh: string,
  goal: bigint,
  deadlineMs: bigint,
  validFromSlot: number,
) {
  const benAddr = await beneficiary.getChangeAddress();
  const { script, scriptAddress } = loadValidator(beneficiaryVkh, goal, deadlineMs);
  const utxo = await findScriptUtxo(scriptAddress);
  const ownUtxos = await provider().fetchAddressUTxOs(benAddr);
  const collateral: UTxO[] = await beneficiary.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr(1, []))
    .txInInlineDatumPresent()
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(beneficiaryVkh)
    .invalidBefore(validFromSlot)
    .invalidHereafter(validFromSlot + 120)
    .changeAddress(benAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await beneficiary.signTx(tx.txHex);
  const txHash = await beneficiary.submitTx(signed);
  console.log(`WITHDRAW ok. tx=${txHash}`);
}

async function reclaim(
  donor: MeshWallet,
  donorVkh: string,
  beneficiaryVkh: string,
  goal: bigint,
  deadlineMs: bigint,
  validFromSlot: number,
) {
  const donorAddr = await donor.getChangeAddress();
  const { script, scriptAddress } = loadValidator(beneficiaryVkh, goal, deadlineMs);
  const utxo = await findScriptUtxo(scriptAddress);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const wallets = decodeWallets(utxo.output.plutusData);
  const myDonation = wallets.get(donorVkh);
  if (!myDonation) throw new Error("No donation recorded");

  const lovelaceIn = BigInt(
    utxo.output.amount.find((a) => a.unit === "lovelace")!.quantity,
  );
  const remaining = lovelaceIn - myDonation;
  const newWallets = new Map<string, bigint>();
  for (const [k, v] of wallets) if (k !== donorVkh) newWallets.set(k, v);

  const ownUtxos = await provider().fetchAddressUTxOs(donorAddr);
  const collateral: UTxO[] = await donor.getCollateral();
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let b = tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr(2, []))
    .txInInlineDatumPresent();
  if (remaining > 0n) {
    b = b
      .txOut(scriptAddress, [{ unit: "lovelace", quantity: remaining.toString() }])
      .txOutInlineDatumValue(buildSomeDatum(newWallets), "JSON");
  }
  await b
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(donorVkh)
    .invalidBefore(validFromSlot)
    .invalidHereafter(validFromSlot + 120)
    .changeAddress(donorAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await donor.signTx(tx.txHex);
  const txHash = await donor.submitTx(signed);
  console.log(`RECLAIM ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== crowdfund scenario: init → donate → withdraw ; init → donate → reclaim ===");
  // Roles: owner kicks off + first contribution, beneficiary withdraws on success,
  // donor adds funds (and reclaims on failed campaign). Brewed → pure-ADA collateral on yaci.
  const owner = makeWallet(MeshWallet.brew(false) as string[]);
  const beneficiary = makeWallet(MeshWallet.brew(false) as string[]);
  const donor = makeWallet(MeshWallet.brew(false) as string[]);
  const ownerAddr = await owner.getChangeAddress();
  const benAddr = await beneficiary.getChangeAddress();
  const donorAddr = await donor.getChangeAddress();
  await fundFromFunder(ownerAddr, 30_000_000n);
  await fundFromFunder(benAddr, 30_000_000n);
  await fundFromFunder(donorAddr, 30_000_000n);

  const ownerVkh = resolvePaymentKeyHash(ownerAddr);
  const benVkh = resolvePaymentKeyHash(benAddr);
  const donorVkh = resolvePaymentKeyHash(donorAddr);

  const systemStartSec = await yaciSystemStartSec();

  // Campaign 1: goal=10M, achieved via owner+donor; beneficiary withdraws.
  const goal1 = 10_000_000n;
  const deadline1Slot = (await yaciTipSlot()) + 15;
  const deadline1Ms = BigInt(slotToMs(deadline1Slot, systemStartSec));
  await initCampaign(owner, ownerVkh, benVkh, goal1, deadline1Ms, 6_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await donate(donor, donorVkh, benVkh, goal1, deadline1Ms, 5_000_000n);
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
  await withdraw(beneficiary, benVkh, goal1, deadline1Ms, deadline1Slot + 1);

  // Campaign 2: goal unreachable; donor reclaims contribution.
  const goal2 = 100_000_000n;
  const deadline2Slot = (await yaciTipSlot()) + 15;
  const deadline2Ms = BigInt(slotToMs(deadline2Slot, systemStartSec));
  await initCampaign(owner, ownerVkh, benVkh, goal2, deadline2Ms, 5_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await donate(donor, donorVkh, benVkh, goal2, deadline2Ms, 4_000_000n);
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
  await reclaim(donor, donorVkh, benVkh, goal2, deadline2Ms, deadline2Slot + 1);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
