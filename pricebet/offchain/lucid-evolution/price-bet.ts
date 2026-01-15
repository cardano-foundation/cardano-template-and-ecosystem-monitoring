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

const ORACLE_ADDRESS = "addr_test1wzf90vsc876xrkqlas8y9skhphguc86lpxqcmshks8efskgvxt34m"; // Mock Charli3 preprod address

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
    const lucid = await Lucid(new Koios("https://preprod.koios.rest/api/v1"), "Preprod");
    let address: string;
    if (typeof walletOrAddress === "number" || (!isNaN(Number(walletOrAddress)) && walletOrAddress.toString().length < 5)) {
        selectWallet(lucid, walletOrAddress);
        address = await lucid.wallet().address();
    } else {
        address = walletOrAddress.toString();
    }
    const utxos = await lucid.utxosAt(address);
    const totalLovelace = utxos.reduce((acc, utxo) => acc + utxo.assets.lovelace, 0n);
    console.log(`Address: ${address}`);
    console.log(`Balance: ${totalLovelace} lovelace (${Number(totalLovelace) / 1000000} ADA)`);
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
    const lucid = await getLucid();
    selectWallet(lucid, walletIndex);
    const ownerAddress = await lucid.wallet().address();
    const ownerPKH = getAddressDetails(ownerAddress).paymentCredential?.hash!;

    const betAmount = BigInt(betAmountAda) * 1_000_000n;
    const deadline = BigInt(Date.now() + deadlineInMs);

    const datum: PriceBetDatum = {
        owner: ownerPKH,
        player: null,
        target_rate: BigInt(targetRate),
        deadline: deadline,
        bet_amount: betAmount,
    };

    const validator = getValidator();
    const scriptAddress = validatorToAddress("Preprod", validator);

    const tx = await lucid.newTx()
        .pay.ToAddressWithData(scriptAddress, { kind: "inline", value: Data.to(datum, PriceBetDatum) }, { lovelace: betAmount })
        .complete();

    const signedTx = await tx.sign.withWallet().complete();
    const txHash = await signedTx.submit();
    console.log(`Bet created! Tx Hash: ${txHash}`);
    console.log(`Script Address: ${scriptAddress}`);
    return txHash;
}

export async function joinBet(scriptUtxoHash: string, scriptUtxoIndex: number, walletIndex: number = 1) {
    const lucid = await getLucid();
    selectWallet(lucid, walletIndex);
    const playerAddress = await lucid.wallet().address();
    const playerPKH = getAddressDetails(playerAddress).paymentCredential?.hash!;

    const validator = getValidator();
    const scriptAddress = validatorToAddress("Preprod", validator);

    const [utxo] = await lucid.utxosByOutRef([{ txHash: scriptUtxoHash, outputIndex: scriptUtxoIndex }]);
    if (!utxo) throw new Error("UTXO not found");
    if (!utxo.datum) throw new Error("UTXO must have inline datum");

    const currentDatum = Data.from(utxo.datum, PriceBetDatum);
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
    return txHash;
}

export async function winBet(scriptUtxoHash: string, scriptUtxoIndex: number, oracleUtxoHash: string, oracleUtxoIndex: number, walletIndex: number = 1) {
    const lucid = await getLucid();
    selectWallet(lucid, walletIndex);
    const playerAddress = await lucid.wallet().address();

    const validator = getValidator();
    const [utxo] = await lucid.utxosByOutRef([{ txHash: scriptUtxoHash, outputIndex: scriptUtxoIndex }]);
    const [oracleUtxo] = await lucid.utxosByOutRef([{ txHash: oracleUtxoHash, outputIndex: oracleUtxoIndex }]);

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

    const currentDatum = Data.from(utxo.datum!, PriceBetDatum);

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

if (import.meta.main) {
    const command = Deno.args[0];
    switch (command) {
        case "prepare":
            await prepare(Number(Deno.args[1]) || 2);
            break;
        case "balance":
            await balance(Deno.args[1] || 0);
            break;
        case "create":
            await createBet(Number(Deno.args[1]), Number(Deno.args[2]), Number(Deno.args[3]), Number(Deno.args[4] || 0));
            break;
        case "join":
            await joinBet(Deno.args[1], Number(Deno.args[2]), Number(Deno.args[3] || 1));
            break;
        case "win":
            await winBet(Deno.args[1], Number(Deno.args[2]), Deno.args[3], Number(Deno.args[4]), Number(Deno.args[5] || 1));
            break;
        case "timeout":
            await timeoutBet(Deno.args[1], Number(Deno.args[2]), Number(Deno.args[3] || 0));
            break;
        default:
            console.log("Commands: prepare, balance, create, join, win, timeout");
    }
}
