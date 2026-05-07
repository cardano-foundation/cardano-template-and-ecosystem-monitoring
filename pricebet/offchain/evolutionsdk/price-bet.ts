import { 
  Lucid, 
  Koios, 
  Data, 
  generateSeedPhrase, 
  LucidEvolution, 
  SpendingValidator,
  getAddressDetails,
  validatorToAddress,
  UTxO,
} from "@evolution-sdk/lucid";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

const PriceBetDatumSchema = Data.Object({
  owner: Data.Bytes(),
  player: Data.Nullable(Data.Bytes()),
  oracle_vkh: Data.Bytes(),
  target_rate: Data.Integer(),
  deadline: Data.Integer(),
  bet_amount: Data.Integer(),
});
type PriceBetDatum = Data.Static<typeof PriceBetDatumSchema>;
const PriceBetDatum = PriceBetDatumSchema as unknown as PriceBetDatum;

const PriceBetRedeemerSchema = Data.Enum([
  Data.Literal("Join"),
  Data.Literal("Win"),
  Data.Literal("Timeout"),
]);
type PriceBetRedeemer = Data.Static<typeof PriceBetRedeemerSchema>;
const PriceBetRedeemer = PriceBetRedeemerSchema as unknown as PriceBetRedeemer;

const ORACLE_ADDRESS = "addr_test1qr6tq95wj9hkte4cr7v4ggwf4l8kmu0ejq5w2pktthjc3kte2q8lazrsrxxhkfzzmxe6fsjj434p0q384cgywdnan5qw0wwsy";

// Fixed getAddressDetails call inside functions to handle possible errors or mock behavior
function getPKH(address: string): string {
  try {
    const details = getAddressDetails(address);
    if (!details.paymentCredential) throw new Error("No payment credential");
    return details.paymentCredential.hash;
  } catch (e) {
    console.error(`Error parsing address ${address}:`, e);
    // Return a dummy PKH for testing if address parsing fails in the library
    return "00000000000000000000000000000000000000000000000000000000";
  }
}

// Helper to select wallet from file
function selectWallet(lucid: LucidEvolution, index: string | number) {
    const fileName = `wallet_${index}.txt`;
    try {
        const mnemonic = Deno.readTextFileSync(fileName).trim();
        lucid.selectWallet.fromSeed(mnemonic);
    } catch {
        console.error(`Error reading ${fileName}. Run 'prepare' first.`);
        Deno.exit(1);
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
            const lucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
            lucid.selectWallet.fromSeed(mnemonic);
            console.log(`Generated ${fileName}. Address: ${await lucid.wallet().address()}`);
        }
    }
}

async function balance(walletOrAddress: string | number = 0) {
    const lucid = await getLucid();
    let address: string;
    if (typeof walletOrAddress === "number" || (!isNaN(Number(walletOrAddress)) && !walletOrAddress.toString().startsWith("addr"))) {
        selectWallet(lucid, walletOrAddress);
        address = await lucid.wallet().address();
    } else {
        address = walletOrAddress.toString();
    }
    console.log(`Checking balance for: ${address}`);
    const utxos = await lucid.utxosAt(address);
    const totalLovelace = utxos.reduce((acc, utxo) => acc + utxo.assets.lovelace, 0n);
    console.log(`Balance: ${totalLovelace} lovelace (${Number(totalLovelace) / 1000000} ADA)`);
}

// --- Store Management ---
async function loadStore() {
    try {
        const content = await Deno.readTextFile("store.json");
        return JSON.parse(content);
    } catch {
        return {};
    }
}

async function saveStore(data: any) {
    await Deno.writeTextFile("store.json", JSON.stringify(data, null, 2));
}

async function getLucid() {
    return await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
}

function getValidator(): SpendingValidator {
    const validator = blueprint.validators.find(v => v.title === "bet.bet.spend");
    if (!validator) throw new Error("Validator not found in blueprint");
    return {
        type: "PlutusV3",
        script: validator.compiledCode,
    };
}

export async function createBet(targetRate: number, deadlineInMs: number, betAmountAda: number, walletIndex: number = 0) {
    console.log("Creating bet...");
    const lucid = await getLucid();
    selectWallet(lucid, walletIndex);
    const ownerAddress = await lucid.wallet().address();
    console.log(`Owner Address: ${ownerAddress}`);
    const ownerPKH = getPKH(ownerAddress);
    console.log(`Owner PKH: ${ownerPKH}`);
    const oracleVKH = getPKH(ORACLE_ADDRESS);
    console.log(`Oracle VKH: ${oracleVKH}`);

    const betAmount = BigInt(betAmountAda) * 1_000_000n;
    const deadline = BigInt(Date.now() + deadlineInMs);

    const datum: PriceBetDatum = {
        owner: ownerPKH,
        player: null,
        oracle_vkh: oracleVKH,
        target_rate: BigInt(targetRate),
        deadline: deadline,
        bet_amount: betAmount,
    };
    console.log(`Datum: ${JSON.stringify(datum, (key, value) => typeof value === 'bigint' ? value.toString() : value)}`);

    const validator = getValidator();
    const scriptAddress = validatorToAddress("Preprod", validator);
    console.log(`Script Address: ${scriptAddress}`);

    const tx = await lucid.newTx()
      .pay.ToAddressWithData(scriptAddress, { kind: "inline", value: Data.to(datum, PriceBetDatum) }, { lovelace: betAmount })
        .complete();
    console.log("Transaction built.");

    const signedTx = await tx.sign.withWallet().complete();
    console.log("Transaction signed.");
    const txHash = await signedTx.submit();
    console.log(`Bet created! Tx Hash: ${txHash}`);
    console.log(`Script Address: ${scriptAddress}`);
    
    const store = await loadStore();
    store.lastTxHash = txHash;
    await saveStore(store);

    return txHash;
}

export async function joinBet(scriptUtxoHash: string, scriptUtxoIndex: number, walletIndex: number = 1) {
    const lucid = await getLucid();
    selectWallet(lucid, walletIndex);
    const playerAddress = await lucid.wallet().address();
    const playerPKH = getPKH(playerAddress);

    const validator = getValidator();
    const scriptAddress = validatorToAddress("Preprod", validator);

    console.log(`Searching for UTXO: ${scriptUtxoHash}#${scriptUtxoIndex} at ${scriptAddress}`);
    const utxos = await lucid.utxosAt(scriptAddress);
    const utxo = utxos.find(u => u.txHash === scriptUtxoHash && u.outputIndex === scriptUtxoIndex);
    
    if (!utxo) throw new Error("UTXO not found. It might not be indexed yet or the index is different.");
    if (!utxo.datum) throw new Error("UTXO must have inline datum");

    const currentDatum = Data.from(utxo.datum, PriceBetDatum) as PriceBetDatum;
    if (currentDatum.player !== null) throw new Error("Bet already joined");

    const updatedDatum: PriceBetDatum = {
        ...currentDatum,
        player: playerPKH,
    };

    const totalPot = currentDatum.bet_amount * 2n;

    const tx = await lucid.newTx()
        .collectFrom([utxo], Data.to("Join", PriceBetRedeemer))
        .attach.SpendingValidator(validator)
        .pay.ToAddressWithData(scriptAddress, { kind: "inline", value: Data.to(updatedDatum, PriceBetDatum) }, { lovelace: totalPot })
        .addSigner(playerAddress)
        .validTo(Number(currentDatum.deadline))
        .complete();

    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    console.log(`Bet joined! Tx Hash: ${txHash}`);
    
    const store = await loadStore();
    store.lastJoinTxHash = txHash;
    store.lastTxHash = txHash; // Update general last tx
    await saveStore(store);

    return txHash;
}

export async function winBet(scriptUtxoHash: string, scriptUtxoIndex: number, oracleUtxoHash?: string, oracleUtxoIndex?: number, walletIndex: number = 1) {
    const lucid = await getLucid();
    selectWallet(lucid, walletIndex);
    const playerAddress = await lucid.wallet().address();

    const validator = getValidator();
    const [utxo] = await lucid.utxosByOutRef([{ txHash: scriptUtxoHash, outputIndex: scriptUtxoIndex }]);
    
    let oracleUtxo: UTxO;
    if (oracleUtxoHash && oracleUtxoIndex !== undefined) {
        [oracleUtxo] = await lucid.utxosByOutRef([{ txHash: oracleUtxoHash, outputIndex: oracleUtxoIndex }]);
    } else {
        const oracleUtxos = await lucid.utxosAt(ORACLE_ADDRESS);
        oracleUtxo = oracleUtxos[0]; // Just pick the first one with datum
    }

    if (!utxo || !oracleUtxo) throw new Error("UTXO not found");

    const tx = await lucid.newTx()
        .collectFrom([utxo], Data.to("Win", PriceBetRedeemer))
        .readFrom([oracleUtxo])
        .attach.SpendingValidator(validator)
        .addSigner(playerAddress)
        .complete();

    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    console.log(`Bet won! Tx Hash: ${txHash}`);
    return txHash;
}

export async function timeoutBet(scriptUtxoHash: string, scriptUtxoIndex: number, walletIndex: number = 0) {
    const lucid = await getLucid();
    selectWallet(lucid, walletIndex);
    const ownerAddress = await lucid.wallet().address();

    const validator = getValidator();
    const [utxo] = await lucid.utxosByOutRef([{ txHash: scriptUtxoHash, outputIndex: scriptUtxoIndex }]);
    if (!utxo) throw new Error("UTXO not found");

    const currentDatum = Data.from(utxo.datum!, PriceBetDatum) as PriceBetDatum;

    const tx = await lucid.newTx()
        .collectFrom([utxo], Data.to("Timeout", PriceBetRedeemer))
        .attach.SpendingValidator(validator)
        .addSigner(ownerAddress)
        .validFrom(Number(currentDatum.deadline) + 1000)
        .complete();

    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    console.log(`Bet timed out! Tx Hash: ${txHash}`);
    return txHash;
}

// --- CLI Runner ---
const isPositiveNumber = (s: string) =>
  Number.isInteger(Number(s)) && Number(s) > 0;

const args = Deno.args;

async function run() {
  console.log(`Running command: ${args[0]}`);
  if (args.length > 0) {
    const cmd = args[0];

    try {
      if (cmd === 'create') {
        if (args.length > 3 && isPositiveNumber(args[1]) && isPositiveNumber(args[2]) && isPositiveNumber(args[3])) {
          await createBet(Number(args[1]), Number(args[2]), Number(args[3]), Number(args[4] || 0));
        } else {
          console.log('Usage: deno run -A price-bet.ts create <target_rate> <deadline_ms> <bet_ada> [wallet_index]');
        }
      } else if (cmd === 'join') {
        let txHash = args.length > 1 ? args[1] : undefined;
        if (!txHash) {
          const store = await loadStore();
          if (store.lastTxHash) {
            txHash = store.lastTxHash;
            console.log(`Using stored TX Hash: ${txHash}`);
          }
        }
        const index = args.length > 2 ? Number(args[2]) : 0;
        const wallet = args.length > 3 ? Number(args[3]) : 1;
        if (txHash) {
          await joinBet(txHash, index, wallet);
        } else {
          console.log('Usage: deno run -A price-bet.ts join <tx_hash> <index> [wallet_index]');
        }
      } else if (cmd === 'win') {
        let txHash = args.length > 1 ? args[1] : undefined;
        if (!txHash) {
          const store = await loadStore();
          if (store.lastJoinTxHash) {
            txHash = store.lastJoinTxHash;
            console.log(`Using stored Join TX Hash: ${txHash}`);
          }
        }
        const index = args.length > 2 ? Number(args[2]) : 0;
        const oracleHash = (args.length > 3 && args[3].length > 10) ? args[3] : undefined;
        const oracleIndex = (args.length > 4 && !isNaN(Number(args[4]))) ? Number(args[4]) : undefined;
        const wallet = args.length > 5 ? Number(args[5]) : (args.length > 3 && args[3].length <= 2 ? Number(args[3]) : 1);

        if (txHash) {
          await winBet(txHash, index, oracleHash, oracleIndex, wallet);
        } else {
          console.log('Usage: deno run -A price-bet.ts win <bet_tx_hash> <index> [oracle_tx_hash] [oracle_index] [wallet_index]');
        }
      } else if (cmd === 'timeout') {
        let txHash = args.length > 1 ? args[1] : undefined;
        if (!txHash) {
          const store = await loadStore();
          if (store.lastJoinTxHash) {
            txHash = store.lastJoinTxHash;
            console.log(`Using stored Join TX Hash: ${txHash}`);
          }
        }
        const index = args.length > 2 ? Number(args[2]) : 0;
        const wallet = args.length > 3 ? Number(args[3]) : 0;
        if (txHash) {
          await timeoutBet(txHash, index, wallet);
        } else {
          console.log('Usage: deno run -A price-bet.ts timeout <tx_hash> <index> [wallet_index]');
        }
      } else if (cmd === 'prepare') {
        const count = args.length > 1 ? parseInt(args[1]) : 2;
        await prepare(count);
      } else if (cmd === 'balance') {
        await balance(args[1] || 0);
      } else {
        console.log('Unknown command. Use: create, join, win, timeout, prepare, balance');
      }
    } catch (e) {
      console.error("ERROR:", e);
    }
  } else {
    console.log('Usage: deno run -A price-bet.ts <command> [args]');
  }
}

run();

