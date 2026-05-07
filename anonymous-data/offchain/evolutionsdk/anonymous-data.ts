import {
  Lucid,
  Koios,
  applyParamsToScript,
  Constr,
  Data,
  fromHex,
  toUnit,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Validator,
} from "@evolution-sdk/lucid";
import blake2b from "blake2b";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Anonymous data commit/reveal — Evolution SDK port.
//
//   ID = blake2b_256(pkh || nonce)
//
// Commit (mint): mints exactly one token, asset_name = ID, sent to the script
//   address with an inline datum (the user's opaque payload).
// Reveal (spend): consumes the committed UTxO with redeemer = nonce; the spender
//   is required-signed and their pkh + nonce must reproduce ID.
// ----------------------------------------------------------------------------

const KOIOS_URL = "https://preprod.koios.rest/api/v1";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

// blake2b_256(pkh || nonce)
function computeIdHex(pkhHex: string, nonceHex: string): string {
  const pkh = hexToBytes(pkhHex);
  const nonce = hexToBytes(nonceHex);
  const combined = new Uint8Array(pkh.length + nonce.length);
  combined.set(pkh);
  combined.set(nonce, pkh.length);
  const hash = blake2b(blake2b.BYTES).update(combined).digest();
  return bytesToHex(hash);
}

async function setup() {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  // Wallet selection is up to the caller — `commit` / `reveal` accept a wallet path.
  return { lucid };
}

function loadValidator(): { validator: Validator; policyId: string; scriptAddress: string } {
  const compiledCode = blueprint.validators[0].compiledCode;
  // No validator parameters.
  const script = applyParamsToScript(compiledCode, []);
  const validator: Validator = { type: "PlutusV3", script };
  const policyId = validatorToScriptHash(validator);
  const scriptAddress = validatorToAddress("Preprod", validator);
  return { validator, policyId, scriptAddress };
}

async function commit(walletFile: string, nonceHex: string, dataHex: string) {
  const { lucid } = await setup();
  const mnemonic = Deno.readTextFileSync(walletFile).trim();
  lucid.selectWallet.fromSeed(mnemonic);

  const address = await lucid.wallet().address();
  const { paymentCredential } = (await import("@evolution-sdk/lucid")).getAddressDetails(address);
  if (!paymentCredential) throw new Error("No payment credential on wallet");

  const idHex = computeIdHex(paymentCredential.hash, nonceHex);
  console.log(`ID = blake2b_256(pkh || nonce) = ${idHex}`);

  const { validator, policyId, scriptAddress } = loadValidator();
  const unit = toUnit(policyId, idHex);

  // Mint redeemer for the policy is the id (ByteArray).
  const mintRedeemer = Data.to(idHex);
  // Inline datum on the script output is the user's data (opaque ByteArray).
  const datum = Data.to(dataHex);

  const tx = await lucid
    .newTx()
    .mintAssets({ [unit]: 1n }, mintRedeemer)
    .attach.MintingPolicy(validator)
    .pay.ToContract(scriptAddress, { kind: "inline", value: datum }, { [unit]: 1n })
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Commit submitted. Tx: ${txHash}`);
  console.log(`Reveal later with:  reveal ${walletFile} ${nonceHex}`);
}

async function reveal(walletFile: string, nonceHex: string) {
  const { lucid } = await setup();
  const mnemonic = Deno.readTextFileSync(walletFile).trim();
  lucid.selectWallet.fromSeed(mnemonic);

  const address = await lucid.wallet().address();
  const { paymentCredential } = (await import("@evolution-sdk/lucid")).getAddressDetails(address);
  if (!paymentCredential) throw new Error("No payment credential on wallet");

  const idHex = computeIdHex(paymentCredential.hash, nonceHex);
  const { validator, policyId, scriptAddress } = loadValidator();
  const unit = toUnit(policyId, idHex);

  const utxos = await lucid.utxosAt(scriptAddress);
  const utxo = utxos.find((u) => (u.assets[unit] ?? 0n) === 1n);
  if (!utxo) throw new Error(`Committed UTxO with unit ${unit} not found`);

  const spendRedeemer = Data.to(nonceHex);

  // Note: we do NOT burn the token. The mint handler enforces
  // `token_minted(..., +1)` and would reject a -1 burn. The spend handler
  // imposes no constraint on where the token goes, so we send the full
  // UTxO value (token + lovelace) back to the spender's wallet via change.
  const tx = await lucid
    .newTx()
    .collectFrom([utxo], spendRedeemer)
    .attach.SpendingValidator(validator)
    .addSigner(address)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Reveal submitted. Tx: ${txHash}`);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  if (!cmd) {
    console.log(
      "Usage:\n" +
        "  commit <wallet.json> <nonce_hex> <data_hex>\n" +
        "  reveal <wallet.json> <nonce_hex>\n",
    );
  } else if (cmd === "commit") {
    if (args.length !== 3) console.error("Usage: commit <wallet.json> <nonce_hex> <data_hex>");
    else await commit(args[0], args[1], args[2]);
  } else if (cmd === "reveal") {
    if (args.length !== 2) console.error("Usage: reveal <wallet.json> <nonce_hex>");
    else await reveal(args[0], args[1]);
  } else {
    console.log("Unknown command");
  }
}
