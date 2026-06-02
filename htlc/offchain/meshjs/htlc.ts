import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  builtinByteString,
  integer,
  mConStr,
  mConStr0,
  mConStr1,
  resolvePaymentKeyHash,
  serializePlutusScript,
  stringToHex,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// HTLC: parameterized validator (secret_hash, expiration_ms, owner_vkh) with GUESS / WITHDRAW.
// Scenario runs both paths: claimer reveals the preimage; owner refunds the second lock.
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

async function waitForLockedUtxo(scriptAddr: string, initTxHash: string): Promise<UTxO> {
  const p = provider();
  for (let i = 0; i < 60; i++) {
    const utxos = await p.fetchAddressUTxOs(scriptAddr);
    const u = utxos.find((x) => x.input.txHash === initTxHash);
    if (u) return u;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Locked UTxO ${initTxHash} not found at ${scriptAddr}`);
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

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function loadScript(secretHashHex: string, expirationMs: bigint, ownerVkh: string) {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(
    compiled,
    [
      builtinByteString(secretHashHex),
      integer(Number(expirationMs)),
      builtinByteString(ownerVkh),
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

async function init(
  owner: MeshWallet,
  ownerVkh: string,
  secret: string,
  expirationMs: bigint,
  lovelace: bigint,
): Promise<{ txHash: string; secretHashHex: string }> {
  const secretHashHex = await sha256Hex(secret);
  const { scriptAddress } = loadScript(secretHashHex, expirationMs, ownerVkh);
  const ownerAddr = await owner.getChangeAddress();
  const utxos = await provider().fetchAddressUTxOs(ownerAddr);

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .txOut(scriptAddress, [{ unit: "lovelace", quantity: lovelace.toString() }])
    .txOutInlineDatumValue(mConStr0([]))
    .changeAddress(ownerAddr)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`INIT ok. secretHash=${secretHashHex.slice(0, 12)}… tx=${txHash}`);
  return { txHash, secretHashHex };
}

async function claim(
  claimer: MeshWallet,
  secret: string,
  secretHashHex: string,
  expirationMs: bigint,
  ownerVkh: string,
  initTxHash: string,
) {
  const { script, scriptAddress } = loadScript(secretHashHex, expirationMs, ownerVkh);
  const utxo = await waitForLockedUtxo(scriptAddress, initTxHash);
  const claimerAddr = await claimer.getChangeAddress();
  const claimerVkh = resolvePaymentKeyHash(claimerAddr);
  const ownUtxos = await provider().fetchAddressUTxOs(claimerAddr);
  const collateral: UTxO[] = await claimer.getCollateral();

  const redeemer = mConStr0([stringToHex(secret)]);

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(redeemer)
    .txInInlineDatumPresent()
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(claimerVkh)
    .changeAddress(claimerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await claimer.signTx(tx.txHex);
  const txHash = await claimer.submitTx(signed);
  console.log(`CLAIM ok. tx=${txHash}`);
}

async function refund(
  owner: MeshWallet,
  secretHashHex: string,
  expirationMs: bigint,
  ownerVkh: string,
  initTxHash: string,
  validFromSlot: number,
) {
  const { script, scriptAddress } = loadScript(secretHashHex, expirationMs, ownerVkh);
  const utxo = await waitForLockedUtxo(scriptAddress, initTxHash);
  const ownerAddr = await owner.getChangeAddress();
  const ownUtxos = await provider().fetchAddressUTxOs(ownerAddr);
  const collateral: UTxO[] = await owner.getCollateral();
  const redeemer = mConStr1([]);

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, scriptAddress)
    .txInScript(script)
    .txInRedeemerValue(redeemer)
    .txInInlineDatumPresent()
    .txInCollateral(
      collateral[0].input.txHash,
      collateral[0].input.outputIndex,
      collateral[0].output.amount,
      collateral[0].output.address,
    )
    .requiredSignerHash(ownerVkh)
    // WITHDRAW requires `valid_after expiration` — invalidBefore must be strictly past expirationSlot.
    .invalidBefore(validFromSlot)
    .invalidHereafter(validFromSlot + 120)
    .changeAddress(ownerAddr)
    .selectUtxosFrom(ownUtxos)
    .complete();
  const signed = await owner.signTx(tx.txHex);
  const txHash = await owner.submitTx(signed);
  console.log(`REFUND ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== htlc scenario: init×2 → claim / refund ===");
  // Roles: owner locks + may refund after expiry; claimer reveals the secret for the first lock.
  const owner = makeWallet(MeshWallet.brew(false) as string[]);
  const claimer = makeWallet(MeshWallet.brew(false) as string[]);
  const ownerAddr = await owner.getChangeAddress();
  const claimerAddr = await claimer.getChangeAddress();
  await fundFromFunder(ownerAddr, 30_000_000n);
  await fundFromFunder(claimerAddr, 20_000_000n);
  const ownerVkh = resolvePaymentKeyHash(ownerAddr);

  const secret1 = "open-sesame";
  const exp1 = BigInt(Date.now() + 60 * 60 * 1000);
  const { txHash: tx1, secretHashHex: h1 } = await init(owner, ownerVkh, secret1, exp1, 10_000_000n);
  await waitForLockedUtxo(loadScript(h1, exp1, ownerVkh).scriptAddress, tx1);

  const secret2 = "another-secret";
  const systemStartSec = await yaciSystemStartSec();
  const exp2Slot = (await yaciTipSlot()) + 10;
  const exp2 = BigInt(slotToMs(exp2Slot, systemStartSec));
  const { txHash: tx2, secretHashHex: h2 } = await init(owner, ownerVkh, secret2, exp2, 8_000_000n);

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
  await refund(owner, h2, exp2, ownerVkh, tx2, exp2Slot + 1);

  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
