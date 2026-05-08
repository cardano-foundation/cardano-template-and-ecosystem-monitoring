import {
  Lucid,
  Koios,
  applyParamsToScript,
  Constr,
  Data,
  generateSeedPhrase,
  getAddressDetails,
  validatorToAddress,
  type LucidEvolution,
  type Validator,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ----------------------------------------------------------------------------
// Vesting — Evolution SDK port.
//
// Validator: no parameters.
// Datum: VestingDatum { lock_until: Int, owner: ByteArray, beneficiary: ByteArray }
// Spend allowed if (owner signed) OR (beneficiary signed AND now > lock_until).
// ----------------------------------------------------------------------------

const KOIOS_URL = "https://preprod.koios.rest/api/v1";

function selectWallet(lucid: LucidEvolution, index: string | number) {
  const fileName = `wallet_${index}.txt`;
  try {
    const mnemonic = Deno.readTextFileSync(fileName).trim();
    lucid.selectWallet.fromSeed(mnemonic);
  } catch {
    console.error(`Error reading ${fileName}. Run 'prepare' first.`);
  }
}

async function prepare(amount: number) {
  for (let i = 0; i < amount; i++) {
    const fileName = `wallet_${i}.txt`;
    try {
      await Deno.stat(fileName);
      console.log(`${fileName} already exists, skipping.`);
    } catch {
      const mnemonic = generateSeedPhrase();
      await Deno.writeTextFile(fileName, mnemonic);
      const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
      lucid.selectWallet.fromSeed(mnemonic);
      console.log(`Generated ${fileName}. Address: ${await lucid.wallet().address()}`);
    }
  }
}

function loadValidator(): { validator: Validator; scriptAddress: string } {
  const compiledCode = blueprint.validators[0].compiledCode;
  // No validator parameters.
  const script = applyParamsToScript(compiledCode, []);
  const validator: Validator = { type: "PlutusV3", script };
  const scriptAddress = validatorToAddress("Preprod", validator);
  return { validator, scriptAddress };
}

async function deposit(amount: string, lockUntilMs: string, beneficiaryWalletIndex: string | number) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid, 0); // owner is wallet_0
  const { scriptAddress } = loadValidator();

  const ownerAddr = await lucid.wallet().address();
  const ownerVkh = getAddressDetails(ownerAddr).paymentCredential!.hash;

  // Beneficiary VKH from a different wallet seed.
  const benLucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(benLucid, beneficiaryWalletIndex);
  const beneficiaryAddr = await benLucid.wallet().address();
  const beneficiaryVkh = getAddressDetails(beneficiaryAddr).paymentCredential!.hash;

  // Datum: Constr 0 [lock_until, owner_vkh, beneficiary_vkh]
  const datum = Data.to(new Constr(0, [BigInt(lockUntilMs), ownerVkh, beneficiaryVkh]));

  const tx = await lucid
    .newTx()
    .pay.ToContract(scriptAddress, { kind: "inline", value: datum }, { lovelace: BigInt(amount) })
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Deposit submitted. Tx: ${txHash}`);
  console.log(`Beneficiary: ${beneficiaryAddr}`);
  console.log(`lock_until: ${lockUntilMs} (POSIX ms)`);
}

async function withdrawAsBeneficiary(beneficiaryWalletIndex: string | number) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid, beneficiaryWalletIndex);
  const { validator, scriptAddress } = loadValidator();

  const beneficiaryAddr = await lucid.wallet().address();
  const beneficiaryVkh = getAddressDetails(beneficiaryAddr).paymentCredential!.hash;

  // Find a vesting UTxO whose datum lists this wallet as beneficiary.
  const utxos = await lucid.utxosAt(scriptAddress);
  const utxo = utxos.find((u) => {
    if (!u.datum) return false;
    try {
      const d = Data.from(u.datum) as Constr<unknown>;
      return d.fields[2] === beneficiaryVkh;
    } catch {
      return false;
    }
  });
  if (!utxo) throw new Error("No vesting UTxO found for this beneficiary");

  // Redeemer is unused by the validator — anything serializable works.
  const redeemer = Data.to(new Constr(0, []));

  const now = Date.now();
  const tx = await lucid
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator)
    .pay.ToAddress(beneficiaryAddr, utxo.assets)
    .addSigner(beneficiaryAddr)
    .validFrom(now)
    .validTo(now + 120_000)
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Withdraw submitted. Tx: ${txHash}`);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  if (!cmd) {
    console.log(
      "Usage:\n" +
        "  prepare <count>                       # generate wallet seeds wallet_0..wallet_{N-1}\n" +
        "  deposit <lovelace> <lock_until_ms> <beneficiary_wallet_idx>\n" +
        "  withdraw <beneficiary_wallet_idx>     # claim after lock_until\n",
    );
  } else if (cmd === "prepare") {
    if (!args[0]) console.error("Usage: prepare <count>");
    else await prepare(parseInt(args[0], 10));
  } else if (cmd === "deposit") {
    if (args.length !== 3) console.error("Usage: deposit <lovelace> <lock_until_ms> <beneficiary_wallet_idx>");
    else await deposit(args[0], args[1], args[2]);
  } else if (cmd === "withdraw") {
    if (!args[0]) console.error("Usage: withdraw <beneficiary_wallet_idx>");
    else await withdrawAsBeneficiary(args[0]);
  } else {
    console.log("Unknown command");
  }
}
