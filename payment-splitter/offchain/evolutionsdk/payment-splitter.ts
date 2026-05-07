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
// Configuration
// Validator parameter: List<VerificationKeyHash> — the payees who all receive
// equal lovelace shares when the contract pays out.
// Datum: Datum { owner: VerificationKeyHash }
// Redeemer: Redeemer { message: ByteArray }
// ----------------------------------------------------------------------------

const PAYEE_COUNT = 5;
const KOIOS_URL = "https://preprod.koios.rest/api/v1";

function selectWallet(lucid: LucidEvolution, index: number) {
  const fileName = `wallet_${index}.txt`;
  try {
    const mnemonic = Deno.readTextFileSync(fileName).trim();
    lucid.selectWallet.fromSeed(mnemonic);
  } catch {
    console.error(`Error reading ${fileName}. Run 'prepare' first.`);
  }
}

async function prepare() {
  for (let i = 0; i < PAYEE_COUNT; i++) {
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

// Read all PAYEE_COUNT wallets and return their payment-credential VKHs.
async function loadPayeeVkhs(): Promise<string[]> {
  const vkhs: string[] = [];
  for (let i = 0; i < PAYEE_COUNT; i++) {
    const mnemonic = Deno.readTextFileSync(`wallet_${i}.txt`).trim();
    const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
    lucid.selectWallet.fromSeed(mnemonic);
    const addr = await lucid.wallet().address();
    const { paymentCredential } = getAddressDetails(addr);
    if (!paymentCredential) throw new Error(`No payment credential on wallet_${i}`);
    vkhs.push(paymentCredential.hash);
  }
  return vkhs;
}

async function setup(walletIndex: number) {
  const lucid = await Lucid(new Koios(KOIOS_URL), "Preprod");
  selectWallet(lucid, walletIndex);

  const payeeVkhs = await loadPayeeVkhs();

  const compiledCode = blueprint.validators[0].compiledCode;
  // Validator param is a single argument: List<VKH>. applyParamsToScript takes
  // the list of params; we wrap our list-of-VKHs as one Plutus list.
  const script = applyParamsToScript(compiledCode, [payeeVkhs]);

  const validator: Validator = { type: "PlutusV3", script };
  const scriptAddress = validatorToAddress("Preprod", validator);

  return { lucid, validator, scriptAddress, payeeVkhs };
}

async function lock(amount: string) {
  const { lucid, scriptAddress, payeeVkhs } = await setup(0);

  // Datum: Datum { owner: VerificationKeyHash }  →  Constr 0 [bytes]
  const datum = Data.to(new Constr(0, [payeeVkhs[0]]));

  const tx = await lucid
    .newTx()
    .pay.ToContract(scriptAddress, { kind: "inline", value: datum }, { lovelace: BigInt(amount) })
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Locked ${amount} lovelace at ${scriptAddress}. Tx: ${txHash}`);
}

async function payout() {
  const { lucid, validator, scriptAddress, payeeVkhs } = await setup(0);

  const utxos = await lucid.utxosAt(scriptAddress);
  if (utxos.length === 0) throw new Error("No script UTxOs to spend");
  const utxo = utxos[0];

  const totalLovelace = utxo.assets.lovelace ?? 0n;
  // Even split. Any leftover after integer division goes back to payee 0
  // implicitly via change. The on-chain contract enforces only that all payees
  // receive equal amounts, so the chosen split below has to match.
  const sharePerPayee = totalLovelace / BigInt(PAYEE_COUNT);

  // Redeemer: Redeemer { message: ByteArray }  →  Constr 0 [bytes("payout")]
  const redeemer = Data.to(new Constr(0, [Buffer.from("payout").toString("hex")]));

  let txBuilder = lucid
    .newTx()
    .collectFrom([utxo], redeemer)
    .attach.SpendingValidator(validator);

  for (let i = 0; i < PAYEE_COUNT; i++) {
    const mnemonic = Deno.readTextFileSync(`wallet_${i}.txt`).trim();
    const tmp = await Lucid(new Koios(KOIOS_URL), "Preprod");
    tmp.selectWallet.fromSeed(mnemonic);
    const payeeAddr = await tmp.wallet().address();
    txBuilder = txBuilder.pay.ToAddress(payeeAddr, { lovelace: sharePerPayee });
  }

  const tx = await txBuilder.complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log(`Payout submitted. Tx: ${txHash}`);
}

if (import.meta.main) {
  const [cmd, ...args] = Deno.args;
  if (!cmd) {
    console.log(
      "Usage:\n" +
        "  prepare                  # generate 5 wallet seeds (wallet_0.txt..wallet_4.txt)\n" +
        "  lock <lovelace>          # lock funds at the splitter script\n" +
        "  payout                   # split the script UTxO equally to all 5 payees\n",
    );
  } else if (cmd === "prepare") {
    await prepare();
  } else if (cmd === "lock") {
    if (!args[0]) console.error("Usage: lock <lovelace>");
    else await lock(args[0]);
  } else if (cmd === "payout") {
    await payout();
  } else {
    console.log("Unknown command");
  }
}
