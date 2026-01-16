import {
    KoiosProvider,
    MeshTxBuilder,
    MeshWallet,
    deserializeDatum,
    serializePlutusScript,
    resolvePaymentKeyHash,
    mConStr0,
    mConStr1,
    mConStr2,
    mConStr3,
    mConStr4,
    applyParamsToScript,
    stringToHex,
    hexToString,
    conStr,
    integer
} from "@meshsdk/core";
import {blake2b} from "@cardano-sdk/crypto";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;

// Hardcoded lottery params (reference repo)
const END_REVEAL = 100;
const DELTA = 20;
const BET_AMOUNT = "10000000";

// Hardcoded secrets
const SECRET1 = "3";
const SECRET2 = "4";
const GAME_INDEX = 1;

// --------------------------------------------------
// Wallet helper
// --------------------------------------------------

function loadWallet(walletFile: string): MeshWallet {
    const mnemonic = JSON.parse(Deno.readTextFileSync(walletFile));
    const provider = new KoiosProvider(NETWORK);

    return new MeshWallet({
        networkId: NETWORK_ID,
        fetcher: provider,
        submitter: provider,
        key: { type: "mnemonic", words: mnemonic },
    });
}

// --------------------------------------------------
// Script helpers
// --------------------------------------------------

function loadLotteryScript() {
    const script = applyParamsToScript(
        blueprint.validators[0].compiledCode,
        [integer(GAME_INDEX)],
        "JSON",
    );

    const { address } = serializePlutusScript(
        { code: script, version: "V3" },
        undefined,
        NETWORK_ID,
    );

    return { script, address };
}

// --------------------------------------------------
// Commit helper
// --------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
    return [...bytes]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}


const hashSecret = (s: string): string => {
    const bytes = new TextEncoder().encode(s);
    const hash = blake2b(blake2b.BYTES).update(bytes).digest();
    return bytesToHex(hash);
};
// --------------------------------------------------
// Fetch state UTxO
// --------------------------------------------------

async function getLotteryUtxo(
    provider: KoiosProvider,
    address: string,
) {
    const utxos = await provider.fetchAddressUTxOs(address);
    const state = utxos.find(u => u.output.plutusData);

    if (!state) throw new Error("Lottery state UTxO not found");
    return state;
}

// --------------------------------------------------
// Multisig create (wallet_0 coordinator)
// --------------------------------------------------

export async function multisigCreate(
    coordinatorFile: string,
    player1File: string,
    player2File: string,
) {
    const coordinator = loadWallet(coordinatorFile);
    const player1 = loadWallet(player1File);
    const player2 = loadWallet(player2File);

    const provider = new KoiosProvider(NETWORK);
    const scripts = loadLotteryScript();

    const coordAddr = await coordinator.getChangeAddress();
    const utxos = await provider.fetchAddressUTxOs(coordAddr);
    const collateral = (await coordinator.getCollateral())[0];

    const player1Pkh = resolvePaymentKeyHash(await player1.getChangeAddress());
    const player2Pkh = resolvePaymentKeyHash(await player2.getChangeAddress());

    // INLINE DATUM (exact Aiken order)
    const datum = mConStr0([
        player1Pkh,
        player2Pkh,
        hashSecret(SECRET1),
        hashSecret(SECRET2),
        "",
        "",
        END_REVEAL,
        DELTA,
    ]);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        .txOut(scripts.address, [{ unit: "lovelace", quantity: BET_AMOUNT }])
        .txOutInlineDatumValue(datum)
        .requiredSignerHash(player1Pkh)
        .requiredSignerHash(player2Pkh)
        .txInCollateral(
            collateral.input.txHash,
            collateral.input.outputIndex,
            collateral.output.amount,
            collateral.output.address,
        )
        .changeAddress(coordAddr)
        .selectUtxosFrom(utxos)
        .complete();

    const s1 = await player1.signTx(tx.txHex, true);
    const s2 = await player2.signTx(s1, true);
    const s3 = await coordinator.signTx(s2, true);

    const hash = await coordinator.submitTx(s3);

    console.log("Lottery created");
    console.log("Script address:", scripts.address);
    console.log("Tx Id:", hash);
}

// --------------------------------------------------
// Redeemers (MATCH Aiken ADT)
// --------------------------------------------------

export const reveal1Redeemer = (secret: string) =>
    conStr(0, [
        { bytes: stringToHex(secret) },
    ]);

export const reveal2Redeemer = (secret: string) =>
    conStr(1, [
        { bytes: stringToHex(secret) },
    ]);

const timeout1Redeemer = () => mConStr2([]);
const timeout2Redeemer = () => mConStr3([]);
const settleRedeemer  = () => conStr(4, []);

// --------------------------------------------------
// Generic spend helper (UNCHANGED)
// --------------------------------------------------

async function spendLotteryUtxo(
    wallet: MeshWallet,
    provider: KoiosProvider,
    scripts: { script: string; address: string },
    utxo: any,
    redeemer: any,
    newDatum?: any,
) {
    const changeAddr = await wallet.getChangeAddress();
    const signerPkh = resolvePaymentKeyHash(changeAddr);

    const collateral = (await wallet.getCollateral())[0];
    const walletUtxos = await provider.fetchAddressUTxOs(changeAddr);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        .spendingPlutusScriptV3()
        .txIn(
            utxo.input.txHash,
            utxo.input.outputIndex,
            utxo.output.amount,
            scripts.address,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue(redeemer, "JSON")
        .txInScript(scripts.script);

    if (newDatum) {
        await tx
            .txOut(scripts.address, utxo.output.amount)
            .txOutInlineDatumValue(newDatum);
    }

    await tx
        .txInCollateral(
            collateral.input.txHash,
            collateral.input.outputIndex,
            collateral.output.amount,
            collateral.output.address,
        )
        .requiredSignerHash(signerPkh)
        .changeAddress(changeAddr)
        .selectUtxosFrom(walletUtxos)
        .complete();

    const signed = await wallet.signTx(tx.txHex, true);
    const hash = await wallet.submitTx(signed);

    console.log("Tx submitted:", hash);
}

// --------------------------------------------------
// Reveal helpers
// --------------------------------------------------
async function reveal(
    walletFile: string,
    player: 1 | 2,
    secret: string,
    redeemerFn: (s: string) => any,
) {
    const wallet = loadWallet(walletFile);
    const provider = new KoiosProvider(NETWORK);
    const scripts = loadLotteryScript();

    const utxo = await getLotteryUtxo(provider, scripts.address);

    const fields = deserializeDatum(utxo.output.plutusData).fields;

    const newDatum = mConStr0([
        fields[0].bytes, // player1
        fields[1].bytes, // player2
        fields[2].bytes, // commit1
        fields[3].bytes, // commit2

        // n1
        player === 1 ? stringToHex(secret) : fields[4].bytes,

        // n2
        player === 2 ? stringToHex(secret) : fields[5].bytes,

        END_REVEAL,
        DELTA,
    ]);

    await spendLotteryUtxo(
        wallet,
        provider,
        scripts,
        utxo,
        redeemerFn(secret),
        newDatum,
    );
}


export async function reveal1(walletFile: string) {
    await reveal(walletFile, 1, SECRET1, reveal1Redeemer);
}

export async function reveal2(walletFile: string) {
    await reveal(walletFile,2,  SECRET2, reveal2Redeemer);
}

// --------------------------------------------------
// Timeouts / settle
// --------------------------------------------------

export async function timeout1(walletFile: string) {
    const wallet = loadWallet(walletFile);
    const provider = new KoiosProvider(NETWORK);
    const scripts = loadLotteryScript();
    const utxo = await getLotteryUtxo(provider, scripts.address);

    await spendLotteryUtxo(wallet, provider, scripts, utxo, timeout1Redeemer());
}

export async function timeout2(walletFile: string) {
    const wallet = loadWallet(walletFile);
    const provider = new KoiosProvider(NETWORK);
    const scripts = loadLotteryScript();
    const utxo = await getLotteryUtxo(provider, scripts.address);

    await spendLotteryUtxo(wallet, provider, scripts, utxo, timeout2Redeemer());
}

export async function settle(walletFile1: string, walletFile2: string) {
    const provider = new KoiosProvider(NETWORK);
    const scripts = loadLotteryScript();

    // Load both wallets
    const wallet1 = loadWallet(walletFile1);
    const wallet2 = loadWallet(walletFile2);

    const addr1 = await wallet1.getChangeAddress();
    const addr2 = await wallet2.getChangeAddress();

    const pkh1 = resolvePaymentKeyHash(addr1);
    const pkh2 = resolvePaymentKeyHash(addr2);

    // Fetch lottery state
    const utxo = await getLotteryUtxo(provider, scripts.address);
    const fields = deserializeDatum(utxo.output.plutusData).fields;

    const player1 = fields[0].bytes;
    const player2 = fields[1].bytes;

    const n1 = Number(hexToString(fields[4].bytes));
    const n2 = Number(hexToString(fields[5].bytes));

    console.log(n1,n2)
    if (Number.isNaN(n1) || Number.isNaN(n2)) {
        throw new Error("Both secrets must be revealed before settlement");
    }

    // Determine winner exactly like on-chain
    const winnerPkh =
        (n1 + n2) % 2 == 1 ? player1 : player2;

    // Select the correct wallet
    let winnerWallet: MeshWallet;
    let winnerAddr: string;

    if (pkh1 === winnerPkh) {
        winnerWallet = wallet1;
        winnerAddr = addr1;
    } else if (pkh2 === winnerPkh) {
        winnerWallet = wallet2;
        winnerAddr = addr2;
    } else {
        throw new Error("Neither wallet matches the winning PKH");
    }

    const collateral = (await winnerWallet.getCollateral())[0];
    const walletUtxos = await provider.fetchAddressUTxOs(winnerAddr);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        // spend state UTxO
        .spendingPlutusScriptV3()
        .txIn(
            utxo.input.txHash,
            utxo.input.outputIndex,
            utxo.output.amount,
            scripts.address,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue(settleRedeemer(), "JSON")
        .txInScript(scripts.script)

        // pay everything to winner
        .txOut(
            winnerAddr,
            utxo.output.amount,
        )

        // winner must sign
        .requiredSignerHash(winnerPkh)

        // collateral & balancing
        .txInCollateral(
            collateral.input.txHash,
            collateral.input.outputIndex,
            collateral.output.amount,
            collateral.output.address,
        )
        .changeAddress(winnerAddr)
        .selectUtxosFrom(walletUtxos)
        .complete();

    const signed = await winnerWallet.signTx(tx.txHex, true);
    const hash = await winnerWallet.submitTx(signed);

    console.log("Lottery settled");
    console.log("Winner PKH:", winnerPkh);
    console.log("Tx Id:", hash);
}


// --------------------------------------------------
// CLI
// --------------------------------------------------

if (import.meta.main) {
    const [cmd, a, b, c] = Deno.args;

    switch (cmd) {
        case "multisig-create":
            await multisigCreate(a, b, c);
            break;
        case "reveal1":
            await reveal1(a);
            break;
        case "reveal2":
            await reveal2(a);
            break;
        case "timeout1":
            await timeout1(a);
            break;
        case "timeout2":
            await timeout2(a);
            break;
        case "settle":
            await settle(a,b);
            break;
        default:
            console.log(`
Usage:
  deno run -A lottery.ts multisig-create <wallet_0.json> <wallet_1.json> <wallet_2.json>
  deno run -A lottery.ts reveal1 <wallet.json>
  deno run -A lottery.ts reveal2 <wallet.json>
  deno run -A lottery.ts timeout1 <wallet.json>
  deno run -A lottery.ts timeout2 <wallet.json>
  deno run -A lottery.ts settle   <wallet_1.json> <wallet_2.json>
`);
    }
}
