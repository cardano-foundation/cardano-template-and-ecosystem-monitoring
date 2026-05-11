import {
  Lucid,
  Blockfrost,
  Data,
  applyParamsToScript,
  getAddressDetails,
  toUnit,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Validator,
} from "@evolution-sdk/lucid";
import blake2b from "blake2b";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Anonymous-data commit/reveal. Exercises the validator's Mint (commit) and
// Spend (reveal) redeemers. ID = blake2b_256(pkh || nonce); on reveal the
// validator recomputes it from the signer's pkh and the nonce redeemer.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";

async function lucidAt(accountIndex: number): Promise<LucidEvolution> {
  const lucid = await Lucid(new Blockfrost(YACI_URL, "Dummy Key"), NETWORK);
  lucid.selectWallet.fromSeed(TEST_MNEMONIC, { accountIndex });
  return lucid;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

function computeIdHex(pkhHex: string, nonceHex: string): string {
  const pkh = hexToBytes(pkhHex);
  const nonce = hexToBytes(nonceHex);
  const combined = new Uint8Array(pkh.length + nonce.length);
  combined.set(pkh);
  combined.set(nonce, pkh.length);
  return bytesToHex(blake2b(blake2b.BYTES).update(combined).digest());
}

function loadValidator(): { validator: Validator; policyId: string; scriptAddress: string } {
  const compiledCode = blueprint.validators[0].compiledCode;
  const script = applyParamsToScript(compiledCode, []);
  const validator: Validator = { type: "PlutusV3", script };
  return {
    validator,
    policyId: validatorToScriptHash(validator),
    scriptAddress: validatorToAddress(NETWORK, validator),
  };
}

async function commit(lucid: LucidEvolution, nonceHex: string, dataHex: string): Promise<string> {
  const address = await lucid.wallet().address();
  const pkh = getAddressDetails(address).paymentCredential!.hash;
  const idHex = computeIdHex(pkh, nonceHex);
  const { validator, policyId, scriptAddress } = loadValidator();
  const unit = toUnit(policyId, idHex);

  const tx = await lucid
    .newTx()
    .mintAssets({ [unit]: 1n }, Data.to(idHex))
    .attach.MintingPolicy(validator)
    .pay.ToContract(scriptAddress, { kind: "inline", value: Data.to(dataHex) }, { [unit]: 1n })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`COMMIT ok. id=${idHex.slice(0, 16)}… tx=${txHash}`);
  return idHex;
}

async function reveal(lucid: LucidEvolution, nonceHex: string, idHex: string) {
  const address = await lucid.wallet().address();
  const { validator, policyId, scriptAddress } = loadValidator();
  const unit = toUnit(policyId, idHex);

  let utxo: { assets: Record<string, bigint> } | undefined;
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(scriptAddress);
    utxo = utxos.find((u) => (u.assets[unit] ?? 0n) === 1n) as never;
    if (utxo) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!utxo) throw new Error(`Committed UTxO with unit ${unit} not found`);

  const tx = await lucid
    .newTx()
    .collectFrom([utxo as never], Data.to(nonceHex))
    .attach.SpendingValidator(validator)
    .addSigner(address)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`REVEAL ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== anonymous-data scenario: commit → reveal ===");
  const lucid = await lucidAt(0);
  const nonceHex = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const dataHex = bytesToHex(new TextEncoder().encode("hello-world"));
  const idHex = await commit(lucid, nonceHex, dataHex);
  await new Promise((r) => setTimeout(r, 2000));
  await reveal(lucid, nonceHex, idHex);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
