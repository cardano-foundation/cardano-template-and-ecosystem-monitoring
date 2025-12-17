import {
    KoiosProvider,
    largestFirst,
    MeshTxBuilder,
    MeshWallet,
    resolvePaymentKeyHash,
    resolveScriptHash,
    serializePlutusScript,
    stringToHex,
    UTxO
} from "@meshsdk/core";

import {applyParamsToScript} from "@meshsdk/core-csl";
import {blake2b} from "@cardano-sdk/crypto";

import blueprint from "../../onchain/aiken/plutus.json" with {type: "json"};

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;
const COLLATERAL_ADA = "5000000";

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
// Crypto helpers
// ------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) {
        throw new Error("Invalid hex string");
    }

    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

/**
 * Convert bytes to hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
    return [...bytes]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}


/**
 * Compute ID = blake2b_256(pkh || nonce)
 * Mirrors Aiken:
 *   blake2b_256(concat(pkh, nonce))
 */
function computeIdHex(pkhHex: string, nonceHex: string): string {
    const pkhBytes = hexToBytes(pkhHex);
    const nonceBytes = hexToBytes(nonceHex);

    const combined = new Uint8Array(pkhBytes.length + nonceBytes.length);
    combined.set(pkhBytes);
    combined.set(nonceBytes, pkhBytes.length);

    const hash = blake2b(blake2b.BYTES)
        .update(combined)
        .digest();

    return bytesToHex(hash);
}



// ------------------------------------------------------------
// Script helpers
// ------------------------------------------------------------

/**
 * Returns the anonymous-data validator information.
 *
 * IMPORTANT:
 * - The minting policy ID is the hash of this script.
 * - No parameters are applied.
 */
function getScriptInfo() {
    const compiled = blueprint.validators[0].compiledCode;

    const scriptCbor = applyParamsToScript(compiled, [], "JSON");

    const policyId = resolveScriptHash(scriptCbor, "V3");


    const {address} = serializePlutusScript(
        {code: scriptCbor, version: "V3"},
        //getPayAddrStakeCredential(initiatorPaymentAddress),
        undefined,
        NETWORK_ID,
    )

    return {
        script: scriptCbor,
        policyId,
        scriptAddress: address,
    };
}

// ------------------------------------------------------------
// Commit Phase (Mint + Store)
// ------------------------------------------------------------

/**
 * Reveal ownership and spend a previously committed UTxO.
 *
 * Off-chain responsibilities:
 * 1. Convert nonce to hex
 * 2. Recompute the commit ID as blake2b_256(pkh || nonce)
 * 3. Locate the script UTxO that carries the singleton ID token
 *    (unit = policyId || idHex, quantity = 1)
 * 4. Spend exactly that UTxO with the nonce as redeemer
 *
 * On-chain (validator) guarantees:
 * - Recomputes the same ID from (signer PKH || nonce)
 * - Verifies that the spent UTxO carries the ID token
 *
 * @param walletFile Path to the wallet mnemonic file
 * @param nonce      Human-readable nonce used during commit
 * @throws If no matching committed UTxO is found at the script address
 */
export async function commitData(
    walletFile: string,
    nonce: string,
    data: string,
) {

    const nonceHex = stringToHex(nonce)
    const dataHex = stringToHex(data)
    console.log("=== commitData: input params ===");
    console.log({ walletFile, nonceHex, dataHex });

    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddress = await wallet.getChangeAddress();
    const signerPkh = resolvePaymentKeyHash(changeAddress);

    console.log("=== wallet info ===");
    console.log({
        NETWORK,
        NETWORK_ID,
        changeAddress,
        signerPkh,
    });

    // Derive commit ID from (signer PKH || nonce)
    const idHex = await computeIdHex(signerPkh, nonceHex);

    console.log("=== derived values ===");
    console.log({
        idHex,
    });

    const { script, policyId, scriptAddress } = getScriptInfo();

    console.log("=== script info ===");
    console.log({
        policyId,
        scriptAddress,
        script, // careful: this can be large
    });

    const utxos = await provider.fetchAddressUTxOs(changeAddress);
    const collateral: UTxO[] = await wallet.getCollateral();

    console.log("=== PRE-TXBUILDER SNAPSHOT ===");
    console.log({
        changeAddress,
        signerPkh,
        nonceHex,
        dataHex,
        idHex,
        policyId,
        scriptAddress,
        collateral,
    });

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        // mint singleton ID token
        .mintPlutusScriptV3()
        .mint("1", policyId, idHex)
        .mintingScript(script)
        .mintRedeemerValue(
            { bytes: idHex },
            "JSON"
        )

        // lock token at script with arbitrary user data
        .txOut(
            scriptAddress,
            [{unit: policyId + idHex, quantity: "1"}],
        )
        .txOutInlineDatumValue(dataHex)

        // collateral + signer
        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )
        .requiredSignerHash(signerPkh)
        .changeAddress(changeAddress)
        .selectUtxosFrom(utxos)
        .complete();

    const signed = await wallet.signTx(tx.txHex);
    const txHash = await wallet.submitTx(signed);

    console.log("✅ Commit tx submitted:", txHash);
    console.log(" Secret ID:", idHex);
    console.log(" Policy ID:", policyId);
}

// ------------------------------------------------------------
// Reveal Phase (Spend)
// ------------------------------------------------------------

/**
 * Reveal ownership and spend a previously committed UTxO.
 *
 * Off-chain responsibilities:
 * 1. Recompute the commit ID as blake2b_256(pkh || nonce)
 * 2. Locate the script UTxO that carries the singleton ID token
 *    (unit = policyId || idHex, quantity = 1)
 * 3. Spend exactly that UTxO with the nonce as redeemer
 *
 * On-chain (validator) guarantees:
 * - Recomputes the same ID from (signer PKH || nonce)
 * - Verifies that the spent UTxO carries the ID token
 *
 * @param walletFile Path to the wallet mnemonic file
 * @param nonceHex   Hex-encoded nonce used during commit
 * @throws If no matching committed UTxO is found at the script address
 */
export async function revealData(
    walletFile: string,
    nonce: string,
) {
    const nonceHex = stringToHex(nonce)
    console.log("=== revealData: start ===");
    console.log({ walletFile, nonceHex });

    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddress = await wallet.getChangeAddress();
    const signerPkh = resolvePaymentKeyHash(changeAddress);

    console.log("=== wallet context ===");
    console.log({
        NETWORK,
        changeAddress,
        signerPkh,
    });

    const { script, scriptAddress, policyId } = getScriptInfo();

    console.log("=== script info ===");
    console.log({
        scriptAddress,
        policyId,
    });

    // recompute ID
    const idHex = await computeIdHex(signerPkh, nonceHex);
    const unit = policyId + idHex;

    console.log("=== recomputed commit ID ===");
    console.log({
        idHex,
        unit,
    });

    // fetch script UTxOs
    const scriptUtxos = await provider.fetchAddressUTxOs(scriptAddress);

    // locate committed UTxO
    const committedUtxo = scriptUtxos.find(u =>
        u.output.amount.some(
            a => a.unit === unit && a.quantity === "1"
        )
    );

    if (!committedUtxo) {
        console.error("❌ No committed UTxO found");
        console.error("Expected unit:", unit);
        throw new Error("No committed UTxO found for this ID");
    }

    console.log("=== committed UTxO selected ===");
    console.log({
        txHash: committedUtxo.input.txHash,
        outputIndex: committedUtxo.input.outputIndex,
        amount: committedUtxo.output.amount,
    });

    // wallet UTxOs for fees + change
    const utxos = await provider.fetchAddressUTxOs(changeAddress);
    const collateral = largestFirst(COLLATERAL_ADA, utxos);

    console.log("=== wallet UTxOs ===");
    console.log({
        utxoCount: utxos.length,
        collateral,
    });

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    console.log("=== building reveal transaction ===");

    await tx
        .spendingPlutusScriptV3()
        .txIn(
            committedUtxo.input.txHash,
            committedUtxo.input.outputIndex,
            committedUtxo.output.amount,
            scriptAddress,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue(
            { bytes: nonceHex },
            "JSON"
        )
        .txInScript(script)
        .txOut(
            changeAddress,
            [{unit: policyId + idHex, quantity: "1"}],
        )
        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )
        .requiredSignerHash(signerPkh)
        .changeAddress(changeAddress)
        .selectUtxosFrom(utxos)
        .complete();

    console.log("=== transaction built ===");
    console.log({ txHex: tx.txHex });

    const signed = await wallet.signTx(tx.txHex, true);
    const txHash = await wallet.submitTx(signed);

    console.log("✅ Reveal tx submitted:", txHash);
}

// ------------------------------------------------------------
// CLI entrypoint
// ------------------------------------------------------------
async function main() {
    const [command, ...args] = Deno.args;

    // No command given => print help and exit successfully (CI-safe)
    if (!command) {
        console.log(
          "Usage:\n\n" +
          "  commit <wallet.json> <nonce> <data>\n" +
          "  reveal <wallet.json> <nonce>\n",
        );
        return;
    }

    if (command === "commit") {
        if (args.length !== 3) {
            console.error(
              "Usage:\n" +
              "  deno run -A anonymous-data.ts commit <wallet.json> <nonce> <data>",
            );
            Deno.exit(1);
        }

        const [walletFile, nonce, data] = args;
        await commitData(walletFile, nonce, data);
        return;
    }

    if (command === "reveal") {
        if (args.length !== 2) {
            console.error(
              "Usage:\n" +
              "  deno run -A anonymous-data.ts reveal <wallet.json> <nonce>",
            );
            Deno.exit(1);
        }

        const [walletFile, nonce] = args;
        await revealData(walletFile, nonce);
        return;
    }

    console.error(
      "Unknown command.\n\n" +
      "Commands:\n" +
      "  commit <wallet.json> <nonce> <data>\n" +
      "  reveal <wallet.json> <nonce>",
    );
    Deno.exit(1);
}

if (import.meta.main) {
    main();
}
