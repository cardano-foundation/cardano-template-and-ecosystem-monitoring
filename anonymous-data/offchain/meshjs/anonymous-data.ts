import {
  BlockfrostProvider,
  MeshTxBuilder,
  MeshWallet,
  resolvePaymentKeyHash,
  resolveScriptHash,
  serializePlutusScript,
  type UTxO,
} from "@meshsdk/core";
import { applyParamsToScript } from "@meshsdk/core-csl";
import blake2b from "blake2b";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// Anonymous-data: commit (mint singleton ID-named token + lock datum) then reveal
// (spend with nonce as redeemer; pkh + nonce must hash to the token name).
// Mesh quirk: we omit `evaluator` so Mesh's CPU estimator runs against yaci-devkit.

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
  console.log(`Funded ${targetAddr} with ${lovelace} lovelace. tx=${txHash}`);
  await waitForUtxoAt(targetAddr, 1);
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}
function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function computeIdHex(pkhHex: string, nonceHex: string): string {
  const pkh = hexToBytes(pkhHex);
  const nonce = hexToBytes(nonceHex);
  const combined = new Uint8Array(pkh.length + nonce.length);
  combined.set(pkh);
  combined.set(nonce, pkh.length);
  return bytesToHex(blake2b(blake2b.BYTES).update(combined).digest());
}

function getScriptInfo() {
  const compiled = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(compiled, [], "JSON");
  const policyId = resolveScriptHash(script, "V3");
  const { address } = serializePlutusScript(
    { code: script, version: "V3" },
    undefined,
    NETWORK_ID,
  );
  return { script, policyId, scriptAddress: address };
}

async function pickCollateral(wallet: MeshWallet, utxos: UTxO[]): Promise<UTxO> {
  // yaci-devkit rejects multi-asset collateral; force a pure-ADA UTxO.
  const fromWallet = (await wallet.getCollateral()).filter((u) =>
    u.output.amount.length === 1 && u.output.amount[0].unit === "lovelace",
  );
  if (fromWallet.length > 0) return fromWallet[0];
  const pureAda = utxos.find((u) =>
    u.output.amount.length === 1 &&
    u.output.amount[0].unit === "lovelace" &&
    BigInt(u.output.amount[0].quantity) >= 5_000_000n,
  );
  if (!pureAda) throw new Error("No pure-ADA collateral UTxO available");
  return pureAda;
}

async function commit(wallet: MeshWallet, nonceHex: string, dataHex: string): Promise<string> {
  const changeAddress = await wallet.getChangeAddress();
  const signerPkh = resolvePaymentKeyHash(changeAddress);
  const idHex = computeIdHex(signerPkh, nonceHex);

  const { script, policyId, scriptAddress } = getScriptInfo();
  const utxos = await provider().fetchAddressUTxOs(changeAddress);
  const col = await pickCollateral(wallet, utxos);

  // MeshBlockfrostProvider's evaluator mis-parses yaci-devkit's ogmios JSON-WSP response;
  // omitting it makes mesh fall back to its CPU estimator.
  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .mintPlutusScriptV3()
    .mint("1", policyId, idHex)
    // Inline minting script (vs. mintTxInReference) — script is small and only used once here.
    .mintingScript(script)
    .mintRedeemerValue({ bytes: idHex }, "JSON")
    .txOut(scriptAddress, [{ unit: policyId + idHex, quantity: "1" }])
    .txOutInlineDatumValue(dataHex)
    .txInCollateral(
      col.input.txHash,
      col.input.outputIndex,
      col.output.amount,
      col.output.address,
    )
    .requiredSignerHash(signerPkh)
    .changeAddress(changeAddress)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex);
  const txHash = await wallet.submitTx(signed);
  console.log(`COMMIT ok. id=${idHex.slice(0, 16)}… tx=${txHash}`);
  return idHex;
}

async function reveal(wallet: MeshWallet, nonceHex: string, idHex: string) {
  const changeAddress = await wallet.getChangeAddress();
  const signerPkh = resolvePaymentKeyHash(changeAddress);
  const { script, policyId, scriptAddress } = getScriptInfo();
  const unit = policyId + idHex;

  let committedUtxo: UTxO | undefined;
  for (let i = 0; i < 60; i++) {
    const utxos = await provider().fetchAddressUTxOs(scriptAddress);
    committedUtxo = utxos.find((u) =>
      u.output.amount.some((a) => a.unit === unit && a.quantity === "1"),
    );
    if (committedUtxo) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!committedUtxo) throw new Error(`Committed UTxO ${unit} not found`);

  const utxos = await provider().fetchAddressUTxOs(changeAddress);
  const col = await pickCollateral(wallet, utxos);

  const tx = new MeshTxBuilder({ fetcher: provider(), submitter: provider() })
    .setNetwork(NETWORK);
  await tx
    .spendingPlutusScriptV3()
    .txIn(
      committedUtxo.input.txHash,
      committedUtxo.input.outputIndex,
      committedUtxo.output.amount,
      scriptAddress,
    )
    .txInInlineDatumPresent()
    .txInRedeemerValue({ bytes: nonceHex }, "JSON")
    .txInScript(script)
    .txOut(changeAddress, [{ unit, quantity: "1" }])
    .txInCollateral(
      col.input.txHash,
      col.input.outputIndex,
      col.output.amount,
      col.output.address,
    )
    .requiredSignerHash(signerPkh)
    .changeAddress(changeAddress)
    .selectUtxosFrom(utxos)
    .complete();
  const signed = await wallet.signTx(tx.txHex, true);
  const txHash = await wallet.submitTx(signed);
  console.log(`REVEAL ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== anonymous-data scenario: commit → reveal ===");
  // Brewed wallet: starts empty, so funder-deposited UTxOs are guaranteed pure-ADA for collateral.
  const wallet = makeWallet(MeshWallet.brew(false) as string[]);
  await fundFromFunder(await wallet.getChangeAddress(), 30_000_000n);

  const nonceHex = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const dataHex = bytesToHex(new TextEncoder().encode("hello-world"));
  const idHex = await commit(wallet, nonceHex, dataHex);
  await new Promise((r) => setTimeout(r, 2000));
  await reveal(wallet, nonceHex, idHex);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
