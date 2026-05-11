import {
  Lucid,
  Blockfrost,
  applyParamsToScript,
  Data,
  fromText,
  generateSeedPhrase,
  getAddressDetails,
  mintingPolicyToId,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Token-transfer. Parameterised PlutusV3 spend validator (receiver_vkh,
// policy_id, asset_name); the mint side uses the trivial always-true
// PlutusV3 script so we only need to test the spend predicate.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const ASSET_NAME = "TestAsset";
const ALWAYS_TRUE_SCRIPT: Script = { type: "PlutusV3", script: "46450101002499" };

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
}

function loadValidator(receiverVkh: string, policyId: string) {
  const script = applyParamsToScript(blueprint.validators[0].compiledCode, [
    receiverVkh,
    policyId,
    fromText(ASSET_NAME),
  ]);
  const validator: Script = { type: "PlutusV3", script };
  return { validator, scriptAddress: validatorToAddress(NETWORK, validator) };
}

async function mint(lucid: LucidEvolution): Promise<string> {
  const myAddr = await lucid.wallet().address();
  const policyId = mintingPolicyToId(ALWAYS_TRUE_SCRIPT);
  const unit = policyId + fromText(ASSET_NAME);
  const tx = await lucid
    .newTx()
    .mintAssets({ [unit]: 10n }, Data.void())
    .attach.MintingPolicy(ALWAYS_TRUE_SCRIPT)
    .pay.ToAddress(myAddr, { [unit]: 10n })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`MINT ok. unit=${unit.slice(0, 24)}… tx=${txHash}`);
  return unit;
}

async function lock(lucid: LucidEvolution, unit: string): Promise<string> {
  const myAddr = await lucid.wallet().address();
  const myVkh = getAddressDetails(myAddr).paymentCredential!.hash;
  const policyId = validatorToScriptHash(ALWAYS_TRUE_SCRIPT);
  const { scriptAddress } = loadValidator(myVkh, policyId);

  let tokenUtxos: Awaited<ReturnType<LucidEvolution["utxosAtWithUnit"]>> = [];
  for (let i = 0; i < 60; i++) {
    tokenUtxos = await lucid.utxosAtWithUnit(myAddr, unit);
    if (tokenUtxos.length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (tokenUtxos.length === 0) throw new Error("No UTxO with the minted asset found");
  const tokenAmount = tokenUtxos[0].assets[unit];

  const tx = await lucid
    .newTx()
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.void() },
      { [unit]: tokenAmount },
    )
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`LOCK ok. amount=${tokenAmount} → ${scriptAddress.slice(0, 20)}… tx=${txHash}`);
  return scriptAddress;
}

async function unlock(lucid: LucidEvolution) {
  const myAddr = await lucid.wallet().address();
  const myVkh = getAddressDetails(myAddr).paymentCredential!.hash;
  const policyId = validatorToScriptHash(ALWAYS_TRUE_SCRIPT);
  const unit = policyId + fromText(ASSET_NAME);
  const { validator, scriptAddress } = loadValidator(myVkh, policyId);

  let utxo: { assets: Record<string, bigint> } | undefined;
  for (let i = 0; i < 60; i++) {
    const utxos = await lucid.utxosAt(scriptAddress);
    utxo = utxos.find((u) => u.assets[unit] !== undefined) as never;
    if (utxo) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!utxo) throw new Error("No script UTxO holding the asset");
  const tokenAmount = utxo.assets[unit];

  const tx = await lucid
    .newTx()
    .collectFrom([utxo as never], Data.void())
    .attach.SpendingValidator(validator)
    .pay.ToAddress(myAddr, { [unit]: tokenAmount })
    .addSigner(myAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`UNLOCK ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== token-transfer scenario: mint → lock → unlock ===");
  // Use a fresh seed so the wallet starts with no stale tokens — the
  // validator inspects all outputs and would reject leftover assets that
  // accumulated in account 0 from previous runs.
  const seed = generateSeedPhrase();
  const lucid = await lucidFromSeed(seed);
  const addr = await lucid.wallet().address();
  await fundFromIndex0(addr, 30_000_000n);

  const unit = await mint(lucid);
  await new Promise((r) => setTimeout(r, 2000));
  await lock(lucid, unit);
  await new Promise((r) => setTimeout(r, 2000));
  await unlock(lucid);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
