import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  fromText,
  generateSeedPhrase,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type MintingPolicy,
  type SpendingValidator,
} from "@evolution-sdk/lucid";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// ----------------------------------------------------------------------------
// Atomic transaction. One PlutusV3 validator exposes both mint and spend
// purposes; the collect step combines them in a single tx so the spend can
// only succeed alongside a matching mint.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ASSET_NAME = "AtomicToken";
const PASSWORD = "super_secret_password";

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

function getValidatorScripts() {
  const v = blueprint.validators.find((x) => x.title === "atomic.placeholder.mint");
  if (!v) throw new Error("Validator not found");
  const spendValidator: SpendingValidator = { type: "PlutusV3", script: v.compiledCode };
  const mintValidator: MintingPolicy = { type: "PlutusV3", script: v.compiledCode };
  return { spendValidator, mintValidator };
}

async function mintAndLock(lucid: LucidEvolution): Promise<string> {
  const { spendValidator, mintValidator } = getValidatorScripts();
  const policyId = validatorToScriptHash(mintValidator);
  const unit = policyId + fromText(ASSET_NAME);
  const redeemer = Data.to(new Constr(0, [fromText(PASSWORD)]));
  const scriptAddress = validatorToAddress(NETWORK, spendValidator);

  const tx = await lucid
    .newTx()
    .mintAssets({ [unit]: 1n }, redeemer)
    .attach.MintingPolicy(mintValidator)
    .pay.ToContract(scriptAddress, { kind: "inline", value: redeemer }, { [unit]: 1n })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`MINT+LOCK ok. tx=${txHash}`);
  return scriptAddress;
}

async function collect(lucid: LucidEvolution, scriptAddress: string) {
  const { spendValidator, mintValidator } = getValidatorScripts();
  const policyId = validatorToScriptHash(mintValidator);
  const unit = policyId + fromText(ASSET_NAME);
  const redeemer = Data.to(new Constr(0, [fromText(PASSWORD)]));

  let target;
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(scriptAddress);
    target = utxos.find((u) => u.assets[unit] && u.assets[unit] === 1n);
    if (target) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!target) throw new Error("No AtomicToken UTxO at script");

  const tx = await lucid
    .newTx()
    .collectFrom([target], redeemer)
    .mintAssets({ [unit]: 1n }, redeemer)
    .attach.SpendingValidator(spendValidator)
    .attach.MintingPolicy(mintValidator)
    .pay.ToAddress(await lucid.wallet().address(), { [unit]: 2n })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`COLLECT (atomic spend+mint) ok. tx=${txHash}`);
}

async function burn(lucid: LucidEvolution, amount: bigint) {
  const { mintValidator } = getValidatorScripts();
  const policyId = validatorToScriptHash(mintValidator);
  const unit = policyId + fromText(ASSET_NAME);
  const redeemer = Data.to(new Constr(0, [fromText(PASSWORD)]));
  const tx = await lucid
    .newTx()
    .mintAssets({ [unit]: -amount }, redeemer)
    .attach.MintingPolicy(mintValidator)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`BURN ${amount} ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== atomic-transaction scenario: mint+lock → collect → burn ===");
  const seed = generateSeedPhrase();
  const lucid = await lucidFromSeed(seed);
  await fundFromIndex0(await lucid.wallet().address(), 50_000_000n);

  const scriptAddress = await mintAndLock(lucid);
  await new Promise((r) => setTimeout(r, 2000));
  await collect(lucid, scriptAddress);
  await new Promise((r) => setTimeout(r, 2000));
  await burn(lucid, 2n);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
