import {
  Lucid,
  Blockfrost,
  Constr,
  Data,
  applyParamsToScript,
  credentialToAddress,
  fromText,
  generateSeedPhrase,
  getAddressDetails,
  keyHashToCredential,
  paymentCredentialOf,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
} from "@evolution-sdk/lucid";
// PLUTUS_JSON lets the cross-check runner point this flow at any on-chain
// blueprint (aiken, scalus, …); falls back to the local Aiken blueprint.
const BLUEPRINT_PATH =
  Deno.env.get("PLUTUS_JSON") ??
  new URL("../../onchain/aiken/plutus.json", import.meta.url).pathname;
const blueprint = JSON.parse(Deno.readTextFileSync(BLUEPRINT_PATH)) as { validators: any[] };

// ----------------------------------------------------------------------------
// Smart-contract wallet. Three chained PlutusV3 validators: funds (spend
// vault), intent (spend single-use intent UTxO) and wallet (mint policy
// for the intent marker). The minted INTENT_MARKER token is what ties an
// intent UTxO back to the right wallet during executeIntent.
// ----------------------------------------------------------------------------

const YACI_URL = "http://localhost:8080/api/v1";
const NETWORK = "Preprod" as const;
const TEST_MNEMONIC =
  "test test test test test test test test test test test test test test test test test test test test test test test sauce";
const INTENT_ASSETNAME = "INTENT_MARKER";
const VALIDATOR_INDEX = { funds: 0, intent: 2, wallet: 4 } as const;

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

function loadScripts(ownerVkh: string) {
  const code = (i: number) => blueprint.validators[i].compiledCode;
  const intentScript: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(code(VALIDATOR_INDEX.intent), [ownerVkh]),
  };
  const intentHash = validatorToScriptHash(intentScript);
  const walletScript: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(code(VALIDATOR_INDEX.wallet), [ownerVkh, intentHash]),
  };
  const walletHash = validatorToScriptHash(walletScript);
  const fundsScript: Script = {
    type: "PlutusV3",
    script: applyParamsToScript(code(VALIDATOR_INDEX.funds), [ownerVkh, walletHash]),
  };
  return {
    intent: { script: intentScript, address: validatorToAddress(NETWORK, intentScript) },
    wallet: { script: walletScript, policyId: walletHash },
    funds: { script: fundsScript, address: validatorToAddress(NETWORK, fundsScript) },
  };
}

function buildAddressDatum(addr: string): Constr<Data> {
  const details = getAddressDetails(addr);
  const pc = details.paymentCredential!;
  const sc = details.stakeCredential;
  const paymentInner = new Constr(pc.type === "Key" ? 0 : 1, [pc.hash]);
  const stakeInner = sc
    ? new Constr(0, [new Constr(0, [new Constr(sc.type === "Key" ? 0 : 1, [sc.hash])])])
    : new Constr(1, []);
  return new Constr(0, [paymentInner, stakeInner]);
}

async function addFunds(lucid: LucidEvolution, lovelace: bigint): Promise<string> {
  const ownerVkh = paymentCredentialOf(await lucid.wallet().address()).hash;
  const scripts = loadScripts(ownerVkh);
  const datum = Data.to(new Constr(0, [0n, []]));
  const tx = await lucid
    .newTx()
    .pay.ToContract(scripts.funds.address, { kind: "inline", value: datum }, { lovelace })
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`ADD_FUNDS ok. amount=${lovelace} tx=${txHash}`);
  return txHash;
}

async function createIntent(
  lucid: LucidEvolution,
  recipientAddr: string,
  lovelace: bigint,
  data: string,
): Promise<string> {
  const ownerAddr = await lucid.wallet().address();
  const ownerVkh = paymentCredentialOf(ownerAddr).hash;
  const scripts = loadScripts(ownerVkh);
  const unit = scripts.wallet.policyId + fromText(INTENT_ASSETNAME);
  const intentDatum = Data.to(
    new Constr(0, [buildAddressDatum(recipientAddr), lovelace, fromText(data)]),
  );
  const tx = await lucid
    .newTx()
    .mintAssets({ [unit]: 1n }, Data.to(new Constr(0, [])))
    .attach.MintingPolicy(scripts.wallet.script)
    .pay.ToContract(
      scripts.intent.address,
      { kind: "inline", value: intentDatum },
      { [unit]: 1n },
    )
    .addSigner(ownerAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`CREATE_INTENT ok. tx=${txHash}`);
  return txHash;
}

async function executeIntent(lucid: LucidEvolution) {
  const ownerAddr = await lucid.wallet().address();
  const ownerVkh = paymentCredentialOf(ownerAddr).hash;
  const scripts = loadScripts(ownerVkh);
  const unit = scripts.wallet.policyId + fromText(INTENT_ASSETNAME);

  const fundsUtxos = await lucid.utxosAt(scripts.funds.address);
  if (fundsUtxos.length === 0) throw new Error("No funds UTxO");
  const fundsUtxo = fundsUtxos[0];

  const intentUtxos = await lucid.utxosAtWithUnit(scripts.intent.address, unit);
  if (intentUtxos.length === 0) throw new Error("No intent UTxO");
  const intentUtxo = intentUtxos[0];
  if (!intentUtxo.datum) throw new Error("Intent UTxO has no datum");

  const decoded = Data.from(intentUtxo.datum) as Constr<Data>;
  const lovelaceAmt = decoded.fields[1] as bigint;
  const addrConstr = decoded.fields[0] as Constr<Data>;
  const paymentCred = addrConstr.fields[0] as Constr<Data>;
  const stakeOption = addrConstr.fields[1] as Constr<Data>;
  const paymentHash = paymentCred.fields[0] as string;
  let stakeHash: string | undefined;
  if (stakeOption.index === 0) {
    // Unwrap the Aiken Option<StakeCredential> -> Inline -> Credential chain
    // (Constr 0 [Constr 0 [Constr 0|1 [hash]]]).
    const inline = stakeOption.fields[0] as Constr<Data>;
    const innerCred = inline.fields[0] as Constr<Data>;
    stakeHash = innerCred.fields[0] as string;
  }
  const recipientAddr = credentialToAddress(
    NETWORK,
    paymentCred.index === 0 ? keyHashToCredential(paymentHash) : { type: "Script", hash: paymentHash },
    stakeHash ? keyHashToCredential(stakeHash) : undefined,
  );

  const tx = await lucid
    .newTx()
    .collectFrom([fundsUtxo], Data.to(new Constr(0, [])))
    .attach.SpendingValidator(scripts.funds.script)
    .collectFrom([intentUtxo], Data.void())
    .attach.SpendingValidator(scripts.intent.script)
    .pay.ToAddress(recipientAddr, { lovelace: lovelaceAmt })
    .mintAssets({ [unit]: -1n }, Data.to(new Constr(1, [])))
    .attach.MintingPolicy(scripts.wallet.script)
    .addSigner(ownerAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`EXECUTE ok. paid ${lovelaceAmt} to recipient. tx=${txHash}`);
}

async function withdrawAll(lucid: LucidEvolution) {
  const ownerAddr = await lucid.wallet().address();
  const ownerVkh = paymentCredentialOf(ownerAddr).hash;
  const scripts = loadScripts(ownerVkh);
  const fundsUtxos = await lucid.utxosAt(scripts.funds.address);
  if (fundsUtxos.length === 0) throw new Error("No funds to withdraw");
  const tx = await lucid
    .newTx()
    .collectFrom(fundsUtxos, Data.to(new Constr(1, [])))
    .attach.SpendingValidator(scripts.funds.script)
    .addSigner(ownerAddr)
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`WITHDRAW ok. tx=${txHash}`);
}

async function runScenario() {
  console.log("=== simple-wallet scenario: add-funds → create-intent → execute → withdraw ===");
  // Fresh owner so its UTxOs are clean pure-ADA. account 0 = funder ;
  // account 1 = intent recipient.
  const seed = generateSeedPhrase();
  const lucid = await lucidFromSeed(seed);
  const ownerAddr = await lucid.wallet().address();
  await fundFromIndex0(ownerAddr, 100_000_000n);

  const recipientAddr = await (await lucidAt(1)).wallet().address();

  await addFunds(lucid, 20_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await createIntent(lucid, recipientAddr, 5_000_000n, "test-payment");
  await new Promise((r) => setTimeout(r, 2000));
  await executeIntent(lucid);
  await new Promise((r) => setTimeout(r, 2000));
  await addFunds(lucid, 10_000_000n);
  await new Promise((r) => setTimeout(r, 2000));
  await withdrawAll(lucid);
  console.log("=== Scenario complete ===");
}

if (import.meta.main) {
  await runScenario();
}
