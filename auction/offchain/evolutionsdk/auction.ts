import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  credentialToAddress,
  fromText,
  getAddressDetails,
  toUnit,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Validator,
} from "@evolution-sdk/lucid";
import { SLOT_CONFIG_NETWORK } from "@evolution-sdk/plutus";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// English auction. Single PlutusV3 validator with mint (init the NFT lot)
// and spend (Bid / End) redeemers. End requires validFrom > expiration, so
// the close path waits for the chain tip to roll past the deadline before
// building the tx.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preview" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ASSET_NAME = "auction_nft";
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

const AuctionDatumSchema = Data.Object({
  seller: Data.Bytes(),
  highest_bidder: Data.Bytes(),
  highest_bid: Data.Integer(),
  expiration: Data.Integer(),
  asset_policy: Data.Bytes(),
  asset_name: Data.Bytes(),
});
type AuctionDatum = Data.Static<typeof AuctionDatumSchema>;
const AuctionDatum = AuctionDatumSchema as unknown as AuctionDatum;

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

function setup() {
  const compiledCode = blueprint.validators[0].compiledCode;
  const validator: Validator = { type: "PlutusV3", script: compiledCode };
  return { validator, scriptAddress: validatorToAddress(NETWORK, validator) };
}

async function findScriptUtxo(lucid: LucidEvolution, scriptAddress: string, txHash: string) {
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(scriptAddress);
    const u = utxos.find((x) => x.txHash === txHash && x.outputIndex === 0);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`UTxO ${txHash}#0 not found`);
}

async function initAuction(
  seller: LucidEvolution,
  startingBid: bigint,
  expirationMs: bigint,
): Promise<string> {
  const { validator, scriptAddress } = setup();
  const sellerAddr = await seller.wallet().address();
  const sellerPc = getAddressDetails(sellerAddr).paymentCredential!.hash;
  const policy = validatorToScriptHash(validator);
  const unit = toUnit(policy, fromText(ASSET_NAME));

  // Anchor validity to yaci's actual tip slot rather than Date.now(): yaci's
  // chain ticks slightly faster than wall clock under load.
  const tipSlot = await yaciTipSlot();
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const expirationSlot = Math.floor((Number(expirationMs) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  // Bid/Init both check valid_before(expiration); validTo must land short of it.
  const validToSlot = Math.min(tipSlot + 10, expirationSlot - 5);
  const datum = Data.to({
    seller: sellerPc,
    highest_bidder: "",
    highest_bid: startingBid,
    expiration: expirationMs,
    asset_policy: policy,
    asset_name: fromText(ASSET_NAME),
  }, AuctionDatum);

  const tx = await seller
    .newTx()
    .attach.MintingPolicy(validator)
    .mintAssets({ [unit]: 1n }, Data.void())
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: datum },
      { lovelace: startingBid, [unit]: 1n },
    )
    .addSigner(sellerAddr)
    .validFrom(slotToMs(tipSlot - 5))
    .validTo(slotToMs(validToSlot))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`INIT ok. tx=${txHash}`);
  return txHash;
}

async function bid(
  bidder: LucidEvolution,
  prevTxHash: string,
  newBid: bigint,
): Promise<string> {
  const { validator, scriptAddress } = setup();
  const bidderAddr = await bidder.wallet().address();
  const bidderVkh = getAddressDetails(bidderAddr).paymentCredential!.hash;
  const utxo = await findScriptUtxo(bidder, scriptAddress, prevTxHash);
  if (!utxo.datum) throw new Error("No datum");
  const auction = Data.from(utxo.datum, AuctionDatum) as unknown as {
    seller: string; highest_bidder: string; highest_bid: bigint;
    expiration: bigint; asset_policy: string; asset_name: string;
  };
  const policy = validatorToScriptHash(validator);
  const unit = toUnit(policy, auction.asset_name);

  const previousBidder = auction.highest_bidder;
  const updated = {
    ...auction,
    highest_bidder: bidderVkh,
    highest_bid: newBid,
  };
  const newDatum = Data.to(updated, AuctionDatum);

  // First bid has no previous bidder, so the seller's reserved starting bid
  // is what gets refunded out.
  const refundAddrHash = previousBidder && previousBidder.length > 0
    ? previousBidder
    : auction.seller;
  const refundAddr = credentialToAddress(NETWORK, { type: "Key", hash: refundAddrHash });

  const tipSlot = await yaciTipSlot();
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const expirationSlot = Math.floor((Number(auction.expiration) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  const validToSlot = Math.min(tipSlot + 10, expirationSlot - 5);
  const tx = await bidder
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], Data.void())
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: newDatum },
      { lovelace: newBid, [unit]: 1n },
    )
    .pay.ToAddress(refundAddr, { lovelace: auction.highest_bid })
    .addSigner(bidderAddr)
    .validFrom(slotToMs(tipSlot - 5))
    .validTo(slotToMs(validToSlot))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`BID ok. ${newBid} lovelace tx=${txHash}`);
  return txHash;
}

async function close(
  caller: LucidEvolution,
  txHash: string,
  expirationMs: bigint,
) {
  const { validator, scriptAddress } = setup();
  const callerAddr = await caller.wallet().address();
  const utxo = await findScriptUtxo(caller, scriptAddress, txHash);
  if (!utxo.datum) throw new Error("No datum");
  const auction = Data.from(utxo.datum, AuctionDatum) as unknown as {
    seller: string; highest_bidder: string; highest_bid: bigint;
    expiration: bigint; asset_policy: string; asset_name: string;
  };
  const policy = validatorToScriptHash(validator);
  const unit = toUnit(policy, auction.asset_name);
  const sellerAddr = credentialToAddress(NETWORK, { type: "Key", hash: auction.seller });

  // End requires valid_after(expiration); the tx must declare a validity
  // window that starts strictly past the deadline, so block until the chain
  // tip has actually rolled there.
  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const expirationSlot = Math.floor((Number(expirationMs) - cfg.zeroTime) / cfg.slotLength) + cfg.zeroSlot;
  for (let i = 0; i < 300; i++) {
    const tip = await yaciTipSlot();
    if (tip > expirationSlot) {
      console.log(`tipSlot ${tip} > expirationSlot ${expirationSlot}, proceeding`);
      break;
    }
    if (i % 10 === 0) console.log(`Waiting for chain slot ${tip} → ${expirationSlot}…`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const tipSlot = await yaciTipSlot();
  const validFromSlot = Math.max(expirationSlot + 1, tipSlot - 5);

  let txb = caller
    .newTx()
    .attach.SpendingValidator(validator)
    .collectFrom([utxo], Data.to(new Constr(2, [])));
  if (auction.highest_bidder && auction.highest_bidder.length > 0) {
    const winnerAddr = credentialToAddress(NETWORK, {
      type: "Key", hash: auction.highest_bidder,
    });
    txb = txb
      .pay.ToAddress(winnerAddr, { [unit]: 1n })
      .pay.ToAddress(sellerAddr, { lovelace: auction.highest_bid });
  } else {
    txb = txb.pay.ToAddress(sellerAddr, { [unit]: 1n });
  }
  const tx = await txb
    .addSigner(callerAddr)
    .validFrom(slotToMs(validFromSlot))
    .validTo(slotToMs(validFromSlot + 120))
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const subHash = await signed.submit();
  console.log(`END ok. tx=${subHash}`);
}

async function runScenario() {
  console.log("=== auction scenario: init → bid → bid → end ===");
  await alignSlotConfig();

  // account 0 = seller / funder ; 1 = bidder1 ; 2 = bidder2
  const seller = await lucidAt(0);
  const bidder1 = await lucidAt(1);
  const bidder2 = await lucidAt(2);
  await fundFromIndex0([
    { address: await bidder1.wallet().address(), lovelace: 30_000_000n },
    { address: await bidder2.wallet().address(), lovelace: 30_000_000n },
  ]);

  const cfg = SLOT_CONFIG_NETWORK.Preview;
  const tipSlot = await yaciTipSlot();
  const expirationSlot = tipSlot + 25;
  const expirationMs = BigInt(slotToMs(expirationSlot));

  const initTx = await initAuction(seller, 3_000_000n, expirationMs);
  await new Promise((r) => setTimeout(r, 2000));
  const bid1Tx = await bid(bidder1, initTx, 6_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  const bid2Tx = await bid(bidder2, bid1Tx, 10_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await close(seller, bid2Tx, expirationMs);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
