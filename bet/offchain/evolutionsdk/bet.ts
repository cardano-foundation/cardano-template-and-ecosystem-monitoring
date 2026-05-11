import {
  Blockfrost,
  Constr,
  Data,
  Lucid,
  LucidEvolution,
  Validator,
  assetsToValue,
  credentialToAddress,
  fromText,
  getAddressDetails,
  keyHashToCredential,
  toUnit,
  validatorToAddress,
  validatorToScriptHash,
} from "@evolution-sdk/lucid";
import { SLOT_CONFIG_NETWORK } from "@evolution-sdk/plutus";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// Realign lucid's "Preview" slot config so that validFrom(Date.now()) maps
// to yaci's current slot AND the chain's Plutus POSIXTime round-trips
// correctly. yaci-devkit emulates several instant era transitions before
// Babbage, which starts at relative time 600s — so the chain's effective
// "slot 0" for TxInfo POSIX is 600 seconds *after* yaci's nominal system
// start. We bake that 600s offset into zeroTime here.
const ERA_OFFSET_SECONDS = 600;
async function alignSlotConfig() {
  const block = await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json());
  const zeroTime = (block.time - block.slot + ERA_OFFSET_SECONDS) * 1000;
  SLOT_CONFIG_NETWORK.Preview.zeroTime = zeroTime;
  SLOT_CONFIG_NETWORK.Preview.zeroSlot = 0;
  SLOT_CONFIG_NETWORK.Preview.slotLength = 1000;
}

// ----------------------------------------------------------------------------
// Bet scenario — Evolution SDK against yaci-devkit.
// Single PlutusV3 script provides both mint policy (INIT) and spend validator
// (JOIN, ANNOUNCE_WINNER).
//
// All three actors derive from the same well-known test mnemonic via different
// accountIndices (matches Bet.java).
//   account 0 = player1
//   account 1 = player2     (validator requires player2 ≠ player1 and ≠ oracle)
//   account 2 = oracle
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
// Preview has zeroSlot=0 by default (Preprod has 86400). Combined with a
// runtime override of zeroTime, this lets us pass Date.now() to validFrom/
// validTo and have lucid round-trip back to yaci's current slot number.
const NETWORK = "Preview" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ASSET_NAME = "LuckyNumberSlevin";

const BetDatumSchema = Data.Object({
  player1: Data.Bytes(),
  player2: Data.Bytes(),
  oracle: Data.Bytes(),
  expiration: Data.Integer(),
});
type BetDatum = Data.Static<typeof BetDatumSchema>;
const BetDatum = BetDatumSchema as unknown as BetDatum;

async function lucidAt(accountIndex: number): Promise<LucidEvolution> {
  const lucid = await Lucid(new Blockfrost(YACI_URL, "Dummy Key"), NETWORK);
  lucid.selectWallet.fromSeed(TEST_MNEMONIC, { accountIndex });
  return lucid;
}

async function vkhOf(accountIndex: number): Promise<string> {
  const l = await lucidAt(accountIndex);
  return getAddressDetails(await l.wallet().address()).paymentCredential!.hash;
}

async function fundFromIndex0(
  targets: Array<{ address: string; lovelace: bigint }>,
) {
  // Fund all targets in a single transaction so we don't race the indexer
  // between successive funder transactions.
  const lucid = await lucidAt(0);
  let txb = lucid.newTx();
  for (const t of targets) txb = txb.pay.ToAddress(t.address, { lovelace: t.lovelace });
  const tx = await txb.complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Funded ${targets.length} target(s). tx=${txHash}`);
  for (const t of targets) await waitForUtxosAt(lucid, t.address, 1, 60);
  // player1 = account 0 (the funder) will be the next caller — wait for the
  // funder's own new change UTxO so lucid doesn't re-select the spent input.
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
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ≥${minCount} UTxO at ${address}`);
}

async function waitForOutRef(
  lucid: LucidEvolution,
  txHash: string,
  outputIndex: number,
  timeoutSec = 60,
) {
  for (let i = 0; i < timeoutSec; i++) {
    try {
      const u = await lucid.utxosByOutRef([{ txHash, outputIndex }]);
      if (u.length > 0) return;
    } catch { /* transient */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${txHash}#${outputIndex}`);
}

function loadValidator(): { validator: Validator; scriptAddress: string } {
  const validator: Validator = {
    type: "PlutusV3",
    script: blueprint.validators[0].compiledCode,
  };
  return { validator, scriptAddress: validatorToAddress(NETWORK, validator) };
}

async function init(lovelace: bigint): Promise<{ txHash: string; expirationMs: number }> {
  const { validator, scriptAddress } = loadValidator();
  const lucid = await lucidAt(0); // player1
  const player1Addr = await lucid.wallet().address();
  const player1Vkh = getAddressDetails(player1Addr).paymentCredential!.hash;
  const oracleVkh = await vkhOf(2);

  // Use yaci's actual current slot, not Date.now() — yaci-devkit's chain
  // ticks faster than wall clock so wall-clock-derived slots can lag behind.
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const tipSlot = (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot as number;
  const validFromSlot = tipSlot - 5;
  const validToSlot = tipSlot + 90;
  const expirationSlot = validToSlot + 60;
  const validFromMs = cfg.zeroTime + (validFromSlot - cfg.zeroSlot) * cfg.slotLength;
  const validToMs = cfg.zeroTime + (validToSlot - cfg.zeroSlot) * cfg.slotLength;
  const expirationMs = cfg.zeroTime + (expirationSlot - cfg.zeroSlot) * cfg.slotLength;
  console.log(
    `[init] tipSlot=${tipSlot} validity=[${validFromSlot},${validToSlot}] expirationSlot=${expirationSlot}`,
  );

  const datum = Data.to(
    {
      player1: player1Vkh,
      player2: "",
      oracle: oracleVkh,
      expiration: BigInt(expirationMs),
    },
    BetDatum,
  );

  const policy = validatorToScriptHash(validator);
  const unit = toUnit(policy, fromText(ASSET_NAME));

  const tx = await lucid
    .newTx()
    .attach.MintingPolicy(validator)
    .mintAssets({ [unit]: 1n }, Data.void())
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: datum },
      { lovelace, [unit]: 1n },
    )
    .addSigner(player1Addr)
    // Required by validator: valid_before(validity_range, expiration).
    .validFrom(validFromMs)
    .validTo(validToMs)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`INIT ok. tx=${txHash}, expirationMs=${expirationMs}`);
  return { txHash, expirationMs };
}

async function join(initTxHash: string): Promise<string> {
  const { validator, scriptAddress } = loadValidator();
  const lucid = await lucidAt(1); // player2
  const player2Addr = await lucid.wallet().address();
  const player2Vkh = getAddressDetails(player2Addr).paymentCredential!.hash;

  await waitForOutRef(lucid, initTxHash, 0);
  const [utxo] = await lucid.utxosByOutRef([{ txHash: initTxHash, outputIndex: 0 }]);
  if (!utxo?.datum) throw new Error("Init UTxO missing datum");
  const bet = Data.from(utxo.datum, BetDatum);

  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const tipSlot = (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot as number;
  const expirationSlot = Math.floor((Number(bet.expiration) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const validFromSlot = tipSlot - 5;
  const validToSlot = Math.min(tipSlot + 60, expirationSlot - 5);
  if (validToSlot <= validFromSlot) throw new Error("Bet already expired — cannot JOIN");
  const validFromMs = cfg.zeroTime + (validFromSlot - cfg.zeroSlot) * cfg.slotLength;
  const validToMs = cfg.zeroTime + (validToSlot - cfg.zeroSlot) * cfg.slotLength;
  console.log(`[join] tipSlot=${tipSlot} validity=[${validFromSlot},${validToSlot}] expirationSlot=${expirationSlot}`);
  bet.player2 = player2Vkh;
  const datum = Data.to(bet, BetDatum);

  const lovelaceAmount = assetsToValue(utxo.assets).coin() * 2n;
  const policy = validatorToScriptHash(validator);
  const unit = toUnit(policy, fromText(ASSET_NAME));

  const tx = await lucid
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], Data.void())
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: datum },
      { lovelace: lovelaceAmount, [unit]: 1n },
    )
    .addSigner(player2Addr)
    .validFrom(validFromMs)
    .validTo(validToMs)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`JOIN ok. tx=${txHash}`);
  return txHash;
}

async function announce(joinTxHash: string): Promise<string> {
  const { validator } = loadValidator();
  const lucid = await lucidAt(2); // oracle
  const oracleAddr = await lucid.wallet().address();

  await waitForOutRef(lucid, joinTxHash, 0);
  const [utxo] = await lucid.utxosByOutRef([{ txHash: joinTxHash, outputIndex: 0 }]);
  if (!utxo?.datum) throw new Error("Join UTxO missing datum");
  const bet = Data.from(utxo.datum, BetDatum);
  if (!bet.player2) throw new Error("player2 still empty");

  // Aiken's from_verification_key → enterprise address.
  const winnerVkh = bet.player1;
  const winnerAddress = credentialToAddress(NETWORK, keyHashToCredential(winnerVkh));

  // ANNOUNCE_WINNER = Constr 1 [winner_vkh]
  const redeemer = Data.to(new Constr(1, [winnerVkh]));

  // Validity range strictly after expiration (chain-side).
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const tipSlot = (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot as number;
  const expirationSlot = Math.floor((Number(bet.expiration) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const validFromSlot = Math.max(expirationSlot + 1, tipSlot - 5);
  const validToSlot = validFromSlot + 120;
  const validFromMs = cfg.zeroTime + (validFromSlot - cfg.zeroSlot) * cfg.slotLength;
  const validToMs = cfg.zeroTime + (validToSlot - cfg.zeroSlot) * cfg.slotLength;
  console.log(`[announce] tipSlot=${tipSlot} expirationSlot=${expirationSlot} validity=[${validFromSlot},${validToSlot}]`);

  // Validator demands exactly one output total. Don't add an explicit
  // pay.ToAddress — instead route the entire change (script input + oracle
  // wallet contribution - fee) to the winner via changeAddress, which yields
  // a single output to winnerAddress with NoDatum.
  const tx = await lucid
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], redeemer)
    .addSigner(oracleAddr)
    .validFrom(validFromMs)
    .validTo(validToMs)
    .complete({ changeAddress: winnerAddress });
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`ANNOUNCE ok. winner=${winnerAddress}. tx=${txHash}`);
  return txHash;
}

async function runScenario() {
  console.log("=== bet scenario: init → join → announce ===");
  await alignSlotConfig();

  // Fund player2 and oracle from account 0 so they can pay fees.
  const player2Addr = await (await lucidAt(1)).wallet().address();
  const oracleAddr = await (await lucidAt(2)).wallet().address();
  await fundFromIndex0([
    { address: player2Addr, lovelace: 30_000_000n },
    { address: oracleAddr, lovelace: 10_000_000n },
  ]);

  const { txHash: initTxHash, expirationMs } = await init(10_000_000n);
  const joinTxHash = await join(initTxHash);

  // Wait for chain's current slot to surpass the bet's expiration slot.
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const expirationSlot = Math.floor((expirationMs - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  for (let i = 0; i < 300; i++) {
    const tipSlot = (await fetch(`${YACI_URL}/blocks/latest`).then((r) => r.json())).slot as number;
    if (tipSlot > expirationSlot) {
      console.log(`tipSlot ${tipSlot} > expirationSlot ${expirationSlot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tipSlot} → ${expirationSlot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  await announce(joinTxHash);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
