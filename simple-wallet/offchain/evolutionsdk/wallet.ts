import {
  Lucid,
  Koios,
  applyParamsToScript,
  Constr,
  Data,
  fromText,
  generateSeedPhrase,
  getAddressDetails,
  paymentCredentialOf,
  stakeCredentialOf,
  validatorToAddress,
  validatorToScriptHash,
  type LucidEvolution,
  type Script,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Simple-wallet — Evolution SDK port.
//
// 3 validators with chained parameters:
//   wallet  (mint policy)         param: owner_vkh, intent_script_hash
//   funds   (spend)               param: owner_vkh, wallet_script_hash
//   intent  (spend)               param: owner_vkh
// Parameter chain: intent → wallet (depends on intent hash) → funds (depends on wallet hash).
//
// Operations:
//   prepare        generate wallet.json
//   create-intent  mint INTENT_MARKER + lock intent UTxO at intent script
//   add-funds      lock lovelace at funds script (datum unused)
//   execute        spend funds + intent, pay recipient, burn marker
//   withdraw       withdraw funds back to owner
// ----------------------------------------------------------------------------

const KOIOS_URL = "https://preprod.koios.rest/api/v1";
const INTENT_ASSETNAME = "INTENT_MARKER";

// Validator indices in plutus.json.
const VALIDATOR_INDEX = { funds: 0, intent: 2, wallet: 4 } as const;

function selectWallet(lucid: LucidEvolution, fileName = "wallet.json") {
  const mnemonic = JSON.parse(Deno.readTextFileSync(fileName));
  lucid.selectWallet.fromSeed(
    Array.isArray(mnemonic) ? mnemonic.join(" ") : mnemonic,
  );
}

async function prepare() {
  const fileName = "wallet.json";
  try {
    await Deno.stat(fileName);
    console.log(`${fileName} already exists, skipping.`);
    return;
  } catch { /* not found */ }

  const mnemonic = generateSeedPhrase();
  await Deno.writeTextFile(fileName, JSON.stringify(mnemonic.split(" ")));
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  lucid.selectWallet.fromSeed(mnemonic);
  console.log(`Generated ${fileName}. Address: ${await lucid.wallet().address()}`);
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
    intent: { script: intentScript, address: validatorToAddress("Preprod", intentScript) },
    wallet: { script: walletScript, policyId: walletHash },
    funds: { script: fundsScript, address: validatorToAddress("Preprod", fundsScript) },
  };
}

// Aiken Address constructor: Constr 0 [PaymentCred, Option<StakeCred>]
//   PaymentCred  = Constr 0 [vkh] (verification key) | Constr 1 [hash] (script)
//   Option<...>  = Constr 0 [Constr 0 [Constr 0 [vkh]]] for inline stake key | Constr 1 [] for None
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

async function createIntent(recipientAddr: string, lovelace: string, data: string) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerAddr = await lucid.wallet().address();
  const ownerVkh = paymentCredentialOf(ownerAddr).hash;
  const scripts = loadScripts(ownerVkh);

  const intentDatum = Data.to(
    new Constr(0, [
      buildAddressDatum(recipientAddr),
      BigInt(lovelace),
      fromText(data),
    ]),
  );

  const unit = scripts.wallet.policyId + fromText(INTENT_ASSETNAME);

  const tx = await lucid
    .newTx()
    // mint intent marker (Mint = Constr 0 [])
    .mintAssets({ [unit]: 1n }, Data.to(new Constr(0, [])))
    .attach.MintingPolicy(scripts.wallet.script)
    // lock intent UTxO with marker token
    .pay.ToContract(
      scripts.intent.address,
      { kind: "inline", value: intentDatum },
      { [unit]: 1n },
    )
    .addSigner(ownerAddr)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Intent address: ${scripts.intent.address}`);
  console.log(`Intent created. Tx: ${txHash}`);
}

async function addFunds(lovelace: string) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerVkh = paymentCredentialOf(await lucid.wallet().address()).hash;
  const scripts = loadScripts(ownerVkh);

  // Datum is unused by the funds validator — Constr 0 [0, []] mirrors the meshjs reference.
  const datum = Data.to(new Constr(0, [0n, []]));

  const tx = await lucid
    .newTx()
    .pay.ToContract(
      scripts.funds.address,
      { kind: "inline", value: datum },
      { lovelace: BigInt(lovelace) },
    )
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Funds address: ${scripts.funds.address}`);
  console.log(`Funds added. Tx: ${txHash}`);
}

async function executeIntent() {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerAddr = await lucid.wallet().address();
  const ownerVkh = paymentCredentialOf(ownerAddr).hash;
  const scripts = loadScripts(ownerVkh);
  const unit = scripts.wallet.policyId + fromText(INTENT_ASSETNAME);

  const fundsUtxos = await lucid.utxosAt(scripts.funds.address);
  if (fundsUtxos.length === 0) throw new Error("No funds UTxO found");
  const fundsUtxo = fundsUtxos[0];

  const intentUtxos = await lucid.utxosAtWithUnit(scripts.intent.address, unit);
  if (intentUtxos.length === 0) throw new Error("No intent UTxO found");
  const intentUtxo = intentUtxos[0];
  if (!intentUtxo.datum) throw new Error("Intent UTxO has no datum");

  // Decode intent datum: Constr 0 [recipient_address, lovelace_amt, data]
  const decoded = Data.from(intentUtxo.datum) as Constr<Data>;
  const lovelaceAmt = decoded.fields[1] as bigint;

  // Re-derive recipient address bech32 from the address-Constr in the datum.
  const addrConstr = decoded.fields[0] as Constr<Data>;
  const paymentCred = addrConstr.fields[0] as Constr<Data>;
  const stakeOption = addrConstr.fields[1] as Constr<Data>;
  const paymentHash = paymentCred.fields[0] as string;

  // Decompose stake credential if present.
  let stakeHash: string | undefined;
  if (stakeOption.index === 0) {
    const someInner = stakeOption.fields[0] as Constr<Data>;
    const innerInner = someInner.fields[0] as Constr<Data>;
    const innerCred = innerInner.fields[0] as Constr<Data>;
    stakeHash = innerCred.fields[0] as string;
  }

  // Reconstruct bech32 recipient address using credentialOf helpers.
  // A sender's payment+stake hashes round-trip via lucid's address utility.
  const { credentialToAddress, keyHashToCredential } = await import("@evolution-sdk/lucid");
  const recipientAddr = credentialToAddress(
    "Preprod",
    paymentCred.index === 0 ? keyHashToCredential(paymentHash) : { type: "Script", hash: paymentHash },
    stakeHash ? keyHashToCredential(stakeHash) : undefined,
  );

  const tx = await lucid
    .newTx()
    // spend funds (ExecuteTx = Constr 0 [])
    .collectFrom([fundsUtxo], Data.to(new Constr(0, [])))
    .attach.SpendingValidator(scripts.funds.script)
    // spend intent (redeemer ignored by validator)
    .collectFrom([intentUtxo], Data.void())
    .attach.SpendingValidator(scripts.intent.script)
    // pay recipient
    .pay.ToAddress(recipientAddr, { lovelace: lovelaceAmt })
    // burn marker (Burn = Constr 1 [])
    .mintAssets({ [unit]: -1n }, Data.to(new Constr(1, [])))
    .attach.MintingPolicy(scripts.wallet.script)
    .addSigner(ownerAddr)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Intent executed. Tx: ${txHash}`);
}

async function withdrawAll() {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid);
  const ownerAddr = await lucid.wallet().address();
  const ownerVkh = paymentCredentialOf(ownerAddr).hash;
  const scripts = loadScripts(ownerVkh);

  const fundsUtxos = await lucid.utxosAt(scripts.funds.address);
  if (fundsUtxos.length === 0) throw new Error("No funds to withdraw");

  const tx = await lucid
    .newTx()
    // Withdraw = Constr 1 []
    .collectFrom(fundsUtxos, Data.to(new Constr(1, [])))
    .attach.SpendingValidator(scripts.funds.script)
    .addSigner(ownerAddr)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Withdraw executed. Tx: ${txHash}`);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  if (!cmd) {
    console.log(
      "Usage:\n" +
        "  prepare\n" +
        "  create-intent <recipient_addr> <lovelace> <data>\n" +
        "  add-funds <lovelace>\n" +
        "  execute\n" +
        "  withdraw\n",
    );
  } else if (cmd === "prepare") {
    await prepare();
  } else if (cmd === "create-intent") {
    if (args.length !== 3) console.error("Usage: create-intent <recipient_addr> <lovelace> <data>");
    else await createIntent(args[0], args[1], args[2]);
  } else if (cmd === "add-funds") {
    if (!args[0]) console.error("Usage: add-funds <lovelace>");
    else await addFunds(args[0]);
  } else if (cmd === "execute") {
    await executeIntent();
  } else if (cmd === "withdraw") {
    await withdrawAll();
  } else {
    console.log("Unknown command");
  }
}

// Silence unused-import warning when the helper is bundled with stake support.
void stakeCredentialOf;
