import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  deserializeDatum,
  mConStr0,
  mConStr2,
  resolvePaymentKeyHash,
  resolveScriptHash,
  serializeAddressObj,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";

// PLUTUS_JSON lets the cross-check runner point this same off-chain flow at a
// different on-chain implementation's blueprint (e.g. scalus) without code edits.
// Falls back to the local Aiken blueprint for standalone runs. Loaded dynamically
// (not a static import) so the path can vary at runtime.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// Auction: a single PlutusV3 script handling START (mint), BID, and END (spend).
// Scenario walks init → bid → bid → end with three brewed wallets.
// Mesh quirk: we omit `evaluator` so Mesh's CPU estimator runs against yaci-devkit.

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "preprod";
const NETWORK_ID = 0;
const ASSET_NAME = "auction_nft";
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

async function findScriptUtxo(scriptAddr: string, prevTxHash: string): Promise<UTxO> {
  const p = provider();
  for (let i = 0; i < 60; i++) {
    const utxos = await p.fetchAddressUTxOs(scriptAddr);
    const u = utxos.find((x) => x.input.txHash === prevTxHash && x.input.outputIndex === 0);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`UTxO ${prevTxHash} not found at ${scriptAddr}`);
}

async function fundFromFunder(targets: Array<{ addr: string; lovelace: bigint }>) {
  const wallet = funderWallet();
  const myAddr = await wallet.getChangeAddress();
  const myUtxos = await provider().fetchAddressUTxOs(myAddr);
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let b = tx as unknown as MeshTxBuilder;
  for (const t of targets) {
    b = b.txOut(t.addr, [{ unit: "lovelace", quantity: t.lovelace.toString() }]);
  }
  await b.changeAddress(myAddr).selectUtxosFrom(myUtxos).complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`Funded ${targets.length} target(s). tx=${txHash}`);
  for (const t of targets) await waitForUtxoAt(t.addr, 1);
}

function getScriptInfo() {
  // Look up the validator BY TITLE (fall back to index 0) so a blueprint that
  // orders its validators differently can't silently break the cross-check.
  const v =
    blueprint.validators.find((x: { title: string }) => x.title === "auction.auction.mint") ??
    blueprint.validators[0];
  const compiled = applyParamsToScript(v.compiledCode, [], "JSON");
  const policyId = resolveScriptHash(compiled, "V3");
  const { address: scriptAddress } = serializePlutusScript(
    { code: compiled, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script: compiled, policyId, scriptAddress };
}

function vkhToAddr(vkh: string): string {
  // mPubKeyAddress returns Mesh-shape {alternative,fields}; serializeAddressObj wants JSON-shape
  // {constructor,fields}. The enterprise-style 0/1 nesting here is the JSON shape it expects.
  return serializeAddressObj({
    constructor: 0,
    fields: [
      { constructor: 0, fields: [{ bytes: vkh }] },
      { constructor: 1, fields: [] },
    ],
  } as never, NETWORK_ID);
}

async function init(
  seller: MeshWallet,
  startingBid: bigint,
  expirationMs: number,
): Promise<string> {
  const sellerAddr = await seller.getChangeAddress();
  const sellerVkh = resolvePaymentKeyHash(sellerAddr);
  const { script, policyId, scriptAddress } = getScriptInfo();
  const assetNameHex = stringToHex(ASSET_NAME);
  const unit = policyId + assetNameHex;

  const datum = mConStr0([
    sellerVkh,
    "",
    Number(startingBid),
    expirationMs,
    policyId,
    assetNameHex,
  ]);
  const utxos = await provider().fetchAddressUTxOs(sellerAddr);
  const collateral: UTxO[] = await seller.getCollateral();

  const systemStartSec = await yaciSystemStartSec();
  const tipSlot = await yaciTipSlot();
  const expirationSlot = Math.floor(expirationMs / 1000) - systemStartSec;
  const validToSlot = Math.min(tipSlot + 10, expirationSlot - 5);

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .mintPlutusScriptV3()
    .mint("1", policyId, assetNameHex)
    // Inline minting script (vs. mintTxInReference): no on-chain reference UTxO is set up here.
    .mintingScript(script)
    .mintRedeemerValue(mConStr0([]))
    .txOut(scriptAddress, [
      { unit: "lovelace", quantity: startingBid.toString() },
      { unit, quantity: "1" },
    ])
    .txOutInlineDatumValue(datum)
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(sellerVkh)
    .invalidBefore(tipSlot - 5)
    .invalidHereafter(validToSlot)
    .changeAddress(sellerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await seller.signTx(tx.txHex);
  const txHash = await seller.submitTx(signed);
  console.log(`INIT ok. tx=${txHash}`);
  return txHash;
}

async function bid(bidder: MeshWallet, prevTxHash: string, newBid: bigint): Promise<string> {
  const bidderAddr = await bidder.getChangeAddress();
  const bidderVkh = resolvePaymentKeyHash(bidderAddr);
  const { script, policyId, scriptAddress } = getScriptInfo();
  const assetNameHex = stringToHex(ASSET_NAME);
  const unit = policyId + assetNameHex;
  const utxo = await findScriptUtxo(scriptAddress, prevTxHash);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const d = deserializeDatum(utxo.output.plutusData) as {
    fields: Array<{ bytes?: string; int?: string | number | bigint }>;
  };
  const seller = d.fields[0].bytes ?? "";
  const prevBidder = d.fields[1].bytes ?? "";
  const prevBid = BigInt(d.fields[2].int ?? 0);
  const expirationMs = Number(d.fields[3].int ?? 0);

  const newDatum = mConStr0([
    seller,
    bidderVkh,
    Number(newBid),
    expirationMs,
    policyId,
    assetNameHex,
  ]);

  const refundVkh = prevBidder && prevBidder.length > 0 ? prevBidder : seller;
  const refundAddr = vkhToAddr(refundVkh);

  const ownUtxos = await provider().fetchAddressUTxOs(bidderAddr);
  const collateral: UTxO[] = await bidder.getCollateral();

  const systemStartSec = await yaciSystemStartSec();
  const tipSlot = await yaciTipSlot();
  const expirationSlot = Math.floor(expirationMs / 1000) - systemStartSec;
  const validToSlot = Math.min(tipSlot + 10, expirationSlot - 5);

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr0([]))
    .txInInlineDatumPresent()
    .txOut(scriptAddress, [
      { unit: "lovelace", quantity: newBid.toString() },
      { unit, quantity: "1" },
    ])
    .txOutInlineDatumValue(newDatum)
    .txOut(refundAddr, [{ unit: "lovelace", quantity: prevBid.toString() }])
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(bidderVkh)
    .invalidBefore(tipSlot - 5)
    .invalidHereafter(validToSlot)
    .changeAddress(bidderAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await bidder.signTx(tx.txHex);
  const txHash = await bidder.submitTx(signed);
  console.log(`BID ok. ${newBid} lovelace tx=${txHash}`);
  return txHash;
}

async function close(caller: MeshWallet, prevTxHash: string): Promise<string> {
  const callerAddr = await caller.getChangeAddress();
  const callerVkh = resolvePaymentKeyHash(callerAddr);
  const { script, policyId, scriptAddress } = getScriptInfo();
  const assetNameHex = stringToHex(ASSET_NAME);
  const unit = policyId + assetNameHex;
  const utxo = await findScriptUtxo(scriptAddress, prevTxHash);
  if (!utxo.output.plutusData) throw new Error("No datum");
  const d = deserializeDatum(utxo.output.plutusData) as {
    fields: Array<{ bytes?: string; int?: string | number | bigint }>;
  };
  const seller = d.fields[0].bytes ?? "";
  const winner = d.fields[1].bytes ?? "";
  const highestBid = BigInt(d.fields[2].int ?? 0);
  const expirationMs = Number(d.fields[3].int ?? 0);

  const systemStartSec = await yaciSystemStartSec();
  const expirationSlot = Math.floor(expirationMs / 1000) - systemStartSec;
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
  // END requires the auction to have expired, so invalidBefore must be strictly after expirationSlot.
  const validFromSlot = Math.max(expirationSlot + 1, tipSlot - 5);
  const sellerAddr = vkhToAddr(seller);

  const ownUtxos = await provider().fetchAddressUTxOs(callerAddr);
  const collateral: UTxO[] = await caller.getCollateral();

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  let b = tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(mConStr2([]))
    .txInInlineDatumPresent();
  if (winner && winner.length > 0) {
    const winnerAddr = vkhToAddr(winner);
    b = b
      .txOut(winnerAddr, [{ unit, quantity: "1" }])
      .txOut(sellerAddr, [{ unit: "lovelace", quantity: highestBid.toString() }]);
  } else {
    b = b.txOut(sellerAddr, [{ unit, quantity: "1" }]);
  }
  await b
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(callerVkh)
    .invalidBefore(validFromSlot)
    .invalidHereafter(validFromSlot + 60)
    .changeAddress(callerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await caller.signTx(tx.txHex);
  const txHash = await caller.submitTx(signed);
  console.log(`END ok. tx=${txHash}`);
  return txHash;
}

async function runScenario() {
  console.log("=== auction scenario: init → bid → bid → end ===");
  // Roles: seller mints+lists, bidder1/bidder2 compete; brewed so collateral is pure-ADA on yaci.
  const seller = makeWallet(MeshWallet.brew(false) as string[]);
  const bidder1 = makeWallet(MeshWallet.brew(false) as string[]);
  const bidder2 = makeWallet(MeshWallet.brew(false) as string[]);
  await fundFromFunder([
    { addr: await seller.getChangeAddress(), lovelace: 30_000_000n },
    { addr: await bidder1.getChangeAddress(), lovelace: 30_000_000n },
    { addr: await bidder2.getChangeAddress(), lovelace: 30_000_000n },
  ]);

  const systemStartSec = await yaciSystemStartSec();
  const tipSlot = await yaciTipSlot();
  const expirationSlot = tipSlot + 30;
  const expirationMs = slotToMs(expirationSlot, systemStartSec);

  const initTx = await init(seller, 3_000_000n, expirationMs);
  await new Promise((r) => setTimeout(r, 2000));
  const bid1Tx = await bid(bidder1, initTx, 6_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  const bid2Tx = await bid(bidder2, bid1Tx, 10_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await close(seller, bid2Tx);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
