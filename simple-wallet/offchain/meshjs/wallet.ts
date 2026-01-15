import {
    builtinByteString,
    deserializeAddress,
    deserializeDatum,
    KoiosProvider,
    mConStr0,
    mConStr1,
    MeshTxBuilder,
    MeshWallet,
    mPubKeyAddress,
    resolvePaymentKeyHash,
    resolveScriptHash,
    scriptHash,
    serializeAddressObj,
    serializePlutusScript,
    stringToHex
} from "@meshsdk/core";

import {applyParamsToScript} from "@meshsdk/core-csl";

import blueprint from "../../onchain/aiken/plutus.json" with {type: "json"};

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;
const INTENT_ASSETNAME = "INTENT_MARKER";

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


function getScriptAddress(compiled: string) {
    const {address} = serializePlutusScript(
        {code: compiled, version: "V3"},
        undefined,
        NETWORK_ID,
    );
    return address;
}

function getScriptHash(compiledCode: string) {
    return resolveScriptHash(compiledCode, "V3");
}

// ------------------------------------------------------------
// Load scripts
// ------------------------------------------------------------
const VALIDATOR_INDEX = {
    funds: 0,
    intent: 2,
    wallet: 4,
} as const;

function getValidator(name: keyof typeof VALIDATOR_INDEX) {
    return blueprint.validators[VALIDATOR_INDEX[name]].compiledCode;
}

function loadScripts(ownerPkh: string) {
    const intentScript = applyParamsToScript(
        getValidator("intent"),
        [builtinByteString(ownerPkh)],
        "JSON",
    );

    const walletScript = applyParamsToScript(
        getValidator("wallet"),
        [builtinByteString(ownerPkh), scriptHash(getScriptHash(intentScript))],
        "JSON",
    );

    const fundsScript = applyParamsToScript(
        getValidator("funds"),
        [builtinByteString(ownerPkh), scriptHash(getScriptHash(walletScript))],
        "JSON",
    );

    return {
        intent: {
            script: intentScript,
            address: getScriptAddress(intentScript),
        },
        wallet: {
            script: walletScript,
            policyId: resolveScriptHash(walletScript, "V3"),
        },
        funds: {
            script: fundsScript,
            address: getScriptAddress(fundsScript),
        },
    };
}

// ------------------------------------------------------------
// Create Intent
// ------------------------------------------------------------

export async function createIntent(
    walletFile: string,
    recipientAddr: string,
    lovelace: string,
    data: string,
) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const ownerPkh = resolvePaymentKeyHash(changeAddr);

    const scripts = loadScripts(ownerPkh);

    const utxos = await provider.fetchAddressUTxOs(changeAddr);
    const collateral = await wallet.getCollateral();

    const recipient = deserializeAddress(recipientAddr);

    const intentDatum = mConStr0([
        mPubKeyAddress(recipient.pubKeyHash, recipient.stakeCredentialHash),
        Number(lovelace),
        data,
    ]);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        // mint intent marker
        .mintPlutusScriptV3()
        .mint("1", scripts.wallet.policyId, stringToHex(INTENT_ASSETNAME))
        .mintingScript(scripts.wallet.script)
        .mintRedeemerValue(mConStr0([]))

        // lock intent UTxO
        .txOut(
            scripts.intent.address,
            [{unit: scripts.wallet.policyId + stringToHex(INTENT_ASSETNAME), quantity: "1"}],
        )
        .txOutInlineDatumValue(intentDatum)

        // collateral & signer
        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )
        .requiredSignerHash(ownerPkh)
        .changeAddress(changeAddr)
        .selectUtxosFrom(utxos)
        .complete();

    const signed = await wallet.signTx(tx.txHex);
    const hash = await wallet.submitTx(signed);

    console.log("Intent address:", scripts.intent.address);
    console.log("Intent created: Tx Id: ", hash);
}

// ------------------------------------------------------------
// Fund Funds Script (add lovelace)
// ------------------------------------------------------------

export async function addFunds(
    walletFile: string,
    lovelace: string,
) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const ownerPkh = resolvePaymentKeyHash(changeAddr);

    const scripts = loadScripts(ownerPkh);

    const utxos = await provider.fetchAddressUTxOs(changeAddr);
    const collateral = await wallet.getCollateral();

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        // send lovelace to funds script
        .txOut(
            scripts.funds.address,
            [{unit: "lovelace", quantity: lovelace}],
        )
        .txOutInlineDatumValue(mConStr0([0, []]))

        // collateral & signer
        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )
        .requiredSignerHash(ownerPkh)
        .changeAddress(changeAddr)
        .selectUtxosFrom(utxos)
        .complete();

    const signed = await wallet.signTx(tx.txHex);
    const hash = await wallet.submitTx(signed);

    console.log("Funds address:", scripts.funds.address);
    console.log("Funds script funded: Tx Id:", hash);
}

// Execute Intent
export async function executeIntent(walletFile: string) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const ownerPkh = resolvePaymentKeyHash(changeAddr);

    const scripts = loadScripts(ownerPkh);

    const fundsUtxos = await provider.fetchAddressUTxOs(scripts.funds.address);
    const intentUtxos = await provider.fetchAddressUTxOs(scripts.intent.address);
    const walletUtxos = await provider.fetchAddressUTxOs(changeAddr);
    const collateral = await wallet.getCollateral();

    if (!fundsUtxos.length || !intentUtxos.length) {
        throw new Error("Missing funds or intent UTxO");
    }

    const fundsUtxo = fundsUtxos[0]; // For simplicity assuming that one utxo has sufficient funds to clear the payment intent
    if (!fundsUtxo.output.plutusData) {
        throw new Error("Funds UTxO inline datum missing");
    }

    // picking a utxo for reference code- it could be filtered and selected in real implementation
    const intentUtxo = intentUtxos.find(u =>
        u.output.amount.some(a =>
            a.unit.endsWith(stringToHex(INTENT_ASSETNAME)) && a.quantity === "1"
        )
    );

    if (!intentUtxo || !intentUtxo.output.plutusData) {
        throw new Error("Intent UTxO or inline datum missing");
    }


    // Inline intent datum parsing

    const datum = deserializeDatum(intentUtxo.output.plutusData);

// recipient address
    const payeeAddress = serializeAddressObj(datum.fields[0]);
// intended amount
    const lovelace = Number(datum.fields[1].int).toString();


    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        // spend funds
        .spendingPlutusScriptV3()
        .txIn(
            fundsUtxo.input.txHash,
            fundsUtxo.input.outputIndex,
            fundsUtxo.output.amount,
            scripts.funds.address,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue(mConStr0([]))
        .txInScript(scripts.funds.script)
        // spend intent
        .spendingPlutusScriptV3()
        .txIn(
            intentUtxo.input.txHash,
            intentUtxo.input.outputIndex,
            intentUtxo.output.amount,
            scripts.intent.address,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue("SomeRedeemer")
        .txInScript(scripts.intent.script)

        // pay recipient
        .txOut(
            payeeAddress,
            [{unit: "lovelace", quantity: lovelace}],
        )

        // burn intent marker
        .mintPlutusScriptV3()
        .mint("-1", scripts.wallet.policyId, stringToHex(INTENT_ASSETNAME))
        .mintingScript(scripts.wallet.script)
        .mintRedeemerValue(mConStr1([]))

        // collateral & signer
        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )
        .requiredSignerHash(ownerPkh)
        .changeAddress(changeAddr)
        .selectUtxosFrom(walletUtxos)
        .complete();

    const signed = await wallet.signTx(tx.txHex, true);
    const hash = await wallet.submitTx(signed);

    console.log("Intent executed: Tx Id:", hash);
}

// Withdraw funds

export async function withdrawAll(walletFile: string) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const ownerPkh = resolvePaymentKeyHash(changeAddr);

    const scripts = loadScripts(ownerPkh);

    const fundsUtxos = await provider.fetchAddressUTxOs(scripts.funds.address);
    const walletUtxos = await provider.fetchAddressUTxOs(changeAddr);
    const collateral = await wallet.getCollateral();

    if (!fundsUtxos.length) {
        throw new Error("No funds");
    }

    const fundsUtxo = fundsUtxos[0]; // for simplicity assuming only one utxo at address

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        .spendingPlutusScriptV3()
        .txIn(
            fundsUtxo.input.txHash,
            fundsUtxo.input.outputIndex,
            fundsUtxo.output.amount,
            scripts.funds.address,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue(mConStr1([]))
        .txInScript(scripts.funds.script)

        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )
        .requiredSignerHash(ownerPkh)
        .changeAddress(changeAddr)
        .selectUtxosFrom(walletUtxos)
        .complete();

    const signed = await wallet.signTx(tx.txHex, true);
    const hash = await wallet.submitTx(signed);

    console.log("Withdraw executed: Tx Id: ", hash);
}
