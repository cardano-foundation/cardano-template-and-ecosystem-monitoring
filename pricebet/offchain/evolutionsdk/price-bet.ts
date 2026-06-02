import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  applyParamsToScript,
  credentialToAddress,
  generateSeedPhrase,
  getAddressDetails,
  keyHashToCredential,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
  type SpendingValidator,
  type UTxO,
} from "@evolution-sdk/lucid";
import { SLOT_CONFIG_NETWORK } from "@evolution-sdk/plutus";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// ----------------------------------------------------------------------------
// Price bet against an oracle UTxO. PlutusV3 spend validator exercising
// Join, Win and Timeout. The "oracle" is just an inline OracleDatum sitting
// at an always-true script; Win passes it via readFrom so the validator can
// read the price without spending the oracle output.
// Payouts go to enterprise (no-stake) addresses because the validator
// rebuilds the winner's address with Aiken's from_verification_key.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preview" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ERA_OFFSET_SECONDS = 600;
const ALWAYS_TRUE_SCRIPT: Script = { type: "PlutusV3", script: "46450101002499" };

const PriceBetDatumSchema = Data.Object({
  owner: Data.Bytes(),
  player: Data.Nullable(Data.Bytes()),
  oracle_vkh: Data.Bytes(),
  target_rate: Data.Integer(),
  deadline: Data.Integer(),
  bet_amount: Data.Integer(),
});
type PriceBetDatum = Data.Static<typeof PriceBetDatumSchema>;
const PriceBetDatum = PriceBetDatumSchema as unknown as PriceBetDatum;

const PriceBetRedeemerSchema = Data.Enum([
  Data.Literal("Join"),
  Data.Literal("Win"),
  Data.Literal("Timeout"),
]);
type PriceBetRedeemer = Data.Static<typeof PriceBetRedeemerSchema>;
const PriceBetRedeemer = PriceBetRedeemerSchema as unknown as PriceBetRedeemer;

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

function getValidator(): SpendingValidator {
  const v = blueprint.validators.find((x) => x.title === "bet.bet.spend");
  if (!v) throw new Error("Validator not found");
  return { type: "PlutusV3", script: v.compiledCode };
}

function buildOracleDatum(price: number, timestamp: number, expiry: number): string {
  // OracleDatum = Constr 0 [PriceData]; PriceData GenericData wraps a
  // Map<Int,Int> as Constr 2, matching the on-chain shape.
  const priceMap = new Map<bigint, bigint>();
  priceMap.set(0n, BigInt(price));
  priceMap.set(1n, BigInt(timestamp));
  priceMap.set(2n, BigInt(expiry));
  return Data.to(new Constr(0, [new Constr(2, [priceMap])]));
}

async function setupOracle(lucid: LucidEvolution, price: number, validForMs: number): Promise<{
  oracleScriptHash: string;
  oracleAddress: string;
  oracleUtxo: UTxO;
}> {
  const oracleScriptHash = validatorToScriptHash(ALWAYS_TRUE_SCRIPT);
  const oracleAddress = validatorToAddress(NETWORK, ALWAYS_TRUE_SCRIPT);
  const datum = buildOracleDatum(price, Date.now(), Date.now() + validForMs);
  const tx = await lucid
    .newTx()
    .pay.ToContract(oracleAddress, { kind: "inline", value: datum }, { lovelace: 2_000_000n })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`SETUP_ORACLE ok. tx=${txHash}`);
  let oracleUtxo: UTxO | undefined;
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(oracleAddress);
    oracleUtxo = utxos.find((u) => u.txHash === txHash);
    if (oracleUtxo) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!oracleUtxo) throw new Error("Oracle UTxO not indexed");
  return { oracleScriptHash, oracleAddress, oracleUtxo };
}

async function createBet(
  owner: LucidEvolution,
  oracleScriptHash: string,
  targetRate: number,
  deadlineMs: bigint,
  betAmount: bigint,
): Promise<string> {
  const ownerAddr = await owner.wallet().address();
  const ownerPkh = getAddressDetails(ownerAddr).paymentCredential!.hash;
  const datum: PriceBetDatum = {
    owner: ownerPkh,
    player: null,
    oracle_vkh: oracleScriptHash,
    target_rate: BigInt(targetRate),
    deadline: deadlineMs,
    bet_amount: betAmount,
  };
  const validator = getValidator();
  const scriptAddress = validatorToAddress(NETWORK, validator);
  const tx = await owner
    .newTx()
    .pay.ToAddressWithData(
      scriptAddress,
      { kind: "inline", value: Data.to(datum, PriceBetDatum) },
      { lovelace: betAmount },
    )
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`CREATE ok. tx=${txHash}`);
  return txHash;
}

async function findScriptUtxo(lucid: LucidEvolution, scriptAddr: string, txHash: string) {
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(scriptAddr);
    const u = utxos.find((x) => x.txHash === txHash && x.outputIndex === 0);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`UTxO ${txHash}#0 not found`);
}

async function joinBet(player: LucidEvolution, createTxHash: string): Promise<string> {
  const playerAddr = await player.wallet().address();
  const playerPkh = getAddressDetails(playerAddr).paymentCredential!.hash;
  const validator = getValidator();
  const scriptAddress = validatorToAddress(NETWORK, validator);
  const utxo = await findScriptUtxo(player, scriptAddress, createTxHash);
  if (!utxo.datum) throw new Error("No datum");
  const currentDatum = Data.from(utxo.datum, PriceBetDatum) as unknown as PriceBetDatum;
  const updated: PriceBetDatum = { ...currentDatum, player: playerPkh };
  const totalPot = currentDatum.bet_amount * 2n;

  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const deadlineSlot = Math.floor((Number(currentDatum.deadline) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const tipSlot = await yaciTipSlot();
  const validToSlot = Math.min(tipSlot + 10, deadlineSlot - 1);

  const tx = await player
    .newTx()
    .collectFrom([utxo], Data.to("Join", PriceBetRedeemer))
    .attach.SpendingValidator(validator)
    .pay.ToAddressWithData(
      scriptAddress,
      { kind: "inline", value: Data.to(updated, PriceBetDatum) },
      { lovelace: totalPot },
    )
    .addSigner(playerAddr)
    .validFrom(slotToMs(tipSlot - 5))
    .validTo(slotToMs(validToSlot))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`JOIN ok. tx=${txHash}`);
  return txHash;
}

async function winBet(
  player: LucidEvolution,
  joinTxHash: string,
  oracleUtxo: UTxO,
): Promise<string> {
  const playerAddr = await player.wallet().address();
  const playerPkh = getAddressDetails(playerAddr).paymentCredential!.hash;
  const playerEnterpriseAddr = credentialToAddress(NETWORK, keyHashToCredential(playerPkh));
  const validator = getValidator();
  const scriptAddress = validatorToAddress(NETWORK, validator);
  const utxo = await findScriptUtxo(player, scriptAddress, joinTxHash);
  if (!utxo.datum) throw new Error("No datum");
  const currentDatum = Data.from(utxo.datum, PriceBetDatum) as unknown as PriceBetDatum;
  const totalPot = utxo.assets.lovelace ?? 0n;

  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const deadlineSlot = Math.floor((Number(currentDatum.deadline) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const tipSlot = await yaciTipSlot();
  const validToSlot = Math.min(tipSlot + 10, deadlineSlot - 1);

  // readFrom attaches the oracle UTxO as a reference input — the validator
  // pulls the price from its inline datum without consuming it.
  const tx = await player
    .newTx()
    .collectFrom([utxo], Data.to("Win", PriceBetRedeemer))
    .readFrom([oracleUtxo])
    .attach.SpendingValidator(validator)
    .pay.ToAddress(playerEnterpriseAddr, { lovelace: totalPot })
    .addSigner(playerAddr)
    .validFrom(slotToMs(tipSlot - 5))
    .validTo(slotToMs(validToSlot))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`WIN ok. tx=${txHash}`);
  return txHash;
}

async function timeoutBet(
  owner: LucidEvolution,
  createTxHash: string,
): Promise<string> {
  const ownerAddr = await owner.wallet().address();
  const validator = getValidator();
  const scriptAddress = validatorToAddress(NETWORK, validator);
  const utxo = await findScriptUtxo(owner, scriptAddress, createTxHash);
  if (!utxo.datum) throw new Error("No datum");
  const currentDatum = Data.from(utxo.datum, PriceBetDatum) as unknown as PriceBetDatum;
  const totalPot = utxo.assets.lovelace ?? 0n;

  // Timeout requires valid_after(deadline) — must block until the chain tip
  // actually rolls past the deadline before building the tx.
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const deadlineSlot = Math.floor((Number(currentDatum.deadline) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > deadlineSlot) {
      console.log(`tipSlot ${tip} > deadlineSlot ${deadlineSlot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${deadlineSlot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tipSlot = await yaciTipSlot();
  const validFromSlot = Math.max(deadlineSlot + 1, tipSlot - 5);

  const ownerPkh = getAddressDetails(ownerAddr).paymentCredential!.hash;
  const ownerEnterpriseAddr = credentialToAddress(NETWORK, keyHashToCredential(ownerPkh));
  const tx = await owner
    .newTx()
    .collectFrom([utxo], Data.to("Timeout", PriceBetRedeemer))
    .attach.SpendingValidator(validator)
    .pay.ToAddress(ownerEnterpriseAddr, { lovelace: totalPot })
    .addSigner(ownerAddr)
    .validFrom(slotToMs(validFromSlot))
    .validTo(slotToMs(validFromSlot + 60))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`TIMEOUT ok. tx=${txHash}`);
  return txHash;
}

async function runScenario() {
  console.log("=== pricebet scenario: setup-oracle → create → join → win ; create → timeout ===");
  await alignSlotConfig();

  // account 0 = owner / funder / oracle publisher ; 1 = player
  const owner = await lucidAt(0);
  const player = await lucidAt(1);
  const playerAddr = await player.wallet().address();
  await fundFromIndex0([{ address: playerAddr, lovelace: 30_000_000n }]);

  // Price=100, target=50 so the Win predicate passes in the happy path.
  const { oracleScriptHash, oracleUtxo } = await setupOracle(owner, 100, 24 * 60 * 60 * 1000);
  await new Promise((r) => setTimeout(r, 2000));

  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const tipSlot1 = await yaciTipSlot();
  const deadline1Ms = BigInt(slotToMs(tipSlot1 + 90));
  const createTx1 = await createBet(owner, oracleScriptHash, 50, deadline1Ms, 5_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  const joinTx = await joinBet(player, createTx1);
  await new Promise((r) => setTimeout(r, 2000));
  await winBet(player, joinTx, oracleUtxo);
  await new Promise((r) => setTimeout(r, 2000));

  const tipSlot2 = await yaciTipSlot();
  const deadline2Ms = BigInt(slotToMs(tipSlot2 + 15));
  const createTx2 = await createBet(owner, oracleScriptHash, 50, deadline2Ms, 5_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await timeoutBet(owner, createTx2);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
