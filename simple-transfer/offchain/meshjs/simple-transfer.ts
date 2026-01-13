import {
    KoiosProvider,
    MeshTxBuilder,
    MeshWallet,
    resolvePaymentKeyHash,
    serializePlutusScript,
    builtinByteString,
    UTxO,
} from "@meshsdk/core";

import { applyParamsToScript } from "@meshsdk/core-csl";
import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;

// ------------------------------------------------------------
// Wallet helpers
// ------------------------------------------------------------

function loadWalletFromFile(path: string): MeshWallet {
    const mnemonic = JSON.parse(Deno.readTextFileSync(path));
    const provider = new KoiosProvider(NETWORK);

    return new MeshWallet({
        networkId: NETWORK_ID,
        fetcher: provider,
        submitter: provider,
        key: {
            type: "mnemonic",
            words: mnemonic,
        },
    });
}

// ------------------------------------------------------------
// Script helpers
// ------------------------------------------------------------

function getValidator(name: string) {
    const v = blueprint.validators.find(v =>
        v.title.startsWith(name),
    );
    if (!v) throw new Error(`Validator not found: ${name}`);
    return v.compiledCode;
}

function getScriptAddress(compiled: string) {
    const { address } = serializePlutusScript(
        { code: compiled, version: "V3" },
        undefined,
        NETWORK_ID,
    );
    return address;
}

function loadSimpleTransferScript(receiverPkh: string) {
    const script = applyParamsToScript(
        getValidator("simple_transfer"),
        [builtinByteString(receiverPkh)],
        "JSON",
    );

    return {
        script,
        address: getScriptAddress(script),
    };
}

// ------------------------------------------------------------
// Deposit / Lock ADA into simple_transfer script
// Depositor specifies receiverPkh
// ------------------------------------------------------------

async function depositAda(
    walletFile: string,
    receiverPkh: string,
    lovelace: string,
) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const signerPkh = resolvePaymentKeyHash(changeAddr);

    const utxos = await provider.fetchAddressUTxOs(changeAddr);
    if (!utxos.length) throw new Error("No wallet UTxOs");

    const collateral = await wallet.getCollateral();
    if (!collateral.length) throw new Error("No collateral UTxO");

    const { address } = loadSimpleTransferScript(receiverPkh);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        // Depositor wallet input
        .txIn(
            utxos[0].input.txHash,
            utxos[0].input.outputIndex,
            utxos[0].output.amount,
            utxos[0].output.address,
        )

        // Lock ADA at script address
        .txOut(address, [
            { unit: "lovelace", quantity: lovelace },
        ])
        .txOutInlineDatumValue({ alternative: 0, fields: [] }) // unit datum

        // Collateral
        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )

        // Depositor signs
        .requiredSignerHash(signerPkh)
        .changeAddress(changeAddr)
        .complete();

    const signed = await wallet.signTx(tx.txHex);
    const txHash = await wallet.submitTx(signed);

    console.log("ADA locked at script");
    console.log("Receiver PKH:", receiverPkh);
    console.log("Amount (lovelace):", lovelace);
    console.log("TxHash:", txHash);
}

// ------------------------------------------------------------
// Collect / Unlock ADA from script
// Must be called by receiver wallet
// ------------------------------------------------------------

export async function collectAda(walletFile: string) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const receiverPkh = resolvePaymentKeyHash(changeAddr);

    const { script, address } = loadSimpleTransferScript(receiverPkh);

    const scriptUtxos = await provider.fetchAddressUTxOs(address);
    if (!scriptUtxos.length) throw new Error("No script UTxO found");

    const scriptUtxo: UTxO = scriptUtxos[0];

    const collateral = await wallet.getCollateral();
    if (!collateral.length) throw new Error("No collateral UTxO");

    const walletUtxos = await provider.fetchAddressUTxOs(changeAddr);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        // Spend script UTxO
        .spendingPlutusScriptV3()
        .txIn(
            scriptUtxo.input.txHash,
            scriptUtxo.input.outputIndex,
            scriptUtxo.output.amount,
            address,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue("") // unit
        .txInScript(script)

        // Pay ADA to receiver wallet
        .txOut(changeAddr, [
            { unit: "lovelace", quantity: scriptUtxo.output.amount[0].quantity },
        ])

        // Collateral
        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )

        // Receiver must sign
        .requiredSignerHash(receiverPkh)
        .changeAddress(changeAddr)
        .selectUtxosFrom(walletUtxos)
        .complete();

    const signed = await wallet.signTx(tx.txHex, true);
    const txHash = await wallet.submitTx(signed);

    console.log("ADA collected from script");
    console.log("Receiver PKH:", receiverPkh);
    console.log("TxHash:", txHash);
}

// ------------------------------------------------------------
// CLI entrypoint
// ------------------------------------------------------------

function printUsage() {
    console.log(
        "Usage:\n\n" +
        "  deno run -A simple-transfer.ts deposit <wallet.json> <receiverPkh> <lovelace>\n" +
        "  deno run -A simple-transfer.ts collect <wallet.json>\n",
    );
}

async function main() {
    const [command, ...args] = Deno.args;

    if (!command) {
        printUsage();
        Deno.exit(1);
    }

    if (command === "deposit") {
        if (args.length !== 3) {
            console.error(
                "Usage:\n" +
                "deno run -A simple-transfer.ts deposit <wallet.json> <receiverPkh> <lovelace>",
            );
            Deno.exit(1);
        }

        const [walletFile, receiverPkh, lovelace] = args;
        await depositAda(walletFile, receiverPkh, lovelace);
        return;
    }

    if (command === "collect") {
        if (args.length !== 1) {
            console.error(
                "Usage:\n" +
                "  deno run -A simple-transfer.ts collect <wallet.json>",
            );
            Deno.exit(1);
        }

        await collectAda(args[0]);
        return;
    }

    console.error(`Unknown command: ${command}\n`);
    printUsage();
    Deno.exit(1);
}

// ------------------------------------------------------------
// Run
// ------------------------------------------------------------

if (import.meta.main) {
    main().catch(err => {
        console.error("❌ Error:", err);
        Deno.exit(1);
    });
}
