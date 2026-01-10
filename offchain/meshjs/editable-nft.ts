import {
    KoiosProvider,
    MeshTxBuilder,
    MeshWallet,
    resolvePaymentKeyHash,
    resolveScriptHash,
    serializePlutusScript,
    stringToHex,
    builtinByteString,
    mOutputReference,
    scriptHash,
    mConStr0,
    mConStr1,
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
    const v = blueprint.validators.find(v => v.title.startsWith(name));
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

// ------------------------------------------------------------
// Mint-side script loader (ONE TIME)
// ------------------------------------------------------------

function loadMintScripts(
    seedUtxo: UTxO,
    assetNameHex: string,
) {
    const mintScript = applyParamsToScript(
        getValidator("editable_nft_mint"),
        [mOutputReference(seedUtxo.input.txHash!, seedUtxo.input.outputIndex!)],
    );

    const policyId = resolveScriptHash(mintScript, "V3");

    const stateScript = applyParamsToScript(
        getValidator("editable_nft_state"),
        [scriptHash(policyId), builtinByteString(assetNameHex)],
        "JSON",
    );

    return {
        mintScript,
        policyId,
        stateScript,
        stateAddress: getScriptAddress(stateScript),
    };
}

// ------------------------------------------------------------
// State-side script loader (NO MINT SCRIPT)
// ------------------------------------------------------------

function loadStateScript(
    policyId: string,
    assetNameHex: string,
) {
    const stateScript = applyParamsToScript(
        getValidator("editable_nft_state"),
        [scriptHash(policyId), builtinByteString(assetNameHex)],
        "JSON",
    );

    return {
        script: stateScript,
        address: getScriptAddress(stateScript),
    };
}

// ------------------------------------------------------------
// 1. Mint Editable NFT
// ------------------------------------------------------------

export async function mintEditableNft(
    walletFile: string,
    tokenName: string,
    payload: string,
) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const ownerPkh = resolvePaymentKeyHash(changeAddr);
    console.log("ownerPkh: ",ownerPkh)

    const utxos = await provider.fetchAddressUTxOs(changeAddr);
    const collateral = await wallet.getCollateral();
    if (!utxos.length) throw new Error("No wallet UTxOs");

    const seedUtxo = utxos[0];
    const assetNameHex = stringToHex(tokenName);

    const {
        mintScript,
        policyId,
        stateScript,
        stateAddress,
    } = loadMintScripts(seedUtxo, assetNameHex);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        .txIn(
            seedUtxo.input.txHash,
            seedUtxo.input.outputIndex,
            seedUtxo.output.amount,
            seedUtxo.output.address,
        )

        .mintPlutusScriptV3()
        .mint("1", policyId, assetNameHex)
        .mintingScript(mintScript)
        .mintRedeemerValue(mConStr0([]))

        .txOut(
            stateAddress,
            [{ unit: policyId + assetNameHex, quantity: "1" }],
        )
        .txOutInlineDatumValue(
            mConStr0([ownerPkh, { alternative: 0, fields: [] }, payload]),
        )

        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )
        .requiredSignerHash(ownerPkh)
        .changeAddress(changeAddr)
        .complete();

    const signed = await wallet.signTx(tx.txHex);
    const txHash = await wallet.submitTx(signed);

    console.log("📦 NFT minted: Tx Id:", txHash);
    console.log("policyId :", policyId);
    console.log("assetName:", assetNameHex);
}

// ------------------------------------------------------------
// 2. Update / Edit NFT
// ------------------------------------------------------------

export async function updateEditableNft(
    walletFile: string,
    policyId: string,
    tokenName: string,
    updatedOwnerPkh: string,   //state gets updated to this ownership (could be same as current owner)
    updatedPayload: string,
) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const currentOwnerPkh = resolvePaymentKeyHash(changeAddr);
    const assetNameHex = stringToHex(tokenName);
    const { script, address } = loadStateScript(policyId, assetNameHex);

    const stateUtxos = await provider.fetchAddressUTxOs(address);
    const stateUtxo = stateUtxos[0];
    if (!stateUtxo) throw new Error("No state UTxO");

    const collateral = await wallet.getCollateral();
    const walletUtxos = await provider.fetchAddressUTxOs(changeAddr);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        .spendingPlutusScriptV3()
        .txIn(
            stateUtxo.input.txHash,
            stateUtxo.input.outputIndex,
            stateUtxo.output.amount,
            address,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue(mConStr0([]))
        .txInScript(script)

        .txOut(address, stateUtxo.output.amount)
        .txOutInlineDatumValue(
            mConStr0([updatedOwnerPkh, { alternative: 0, fields: [] }, updatedPayload]),
        )

        .txInCollateral(
            collateral[0].input.txHash,
            collateral[0].input.outputIndex,
            collateral[0].output.amount,
            collateral[0].output.address,
        )
        .requiredSignerHash(currentOwnerPkh)
        .changeAddress(changeAddr)
        .selectUtxosFrom(walletUtxos)
        .complete();

    const signed = await wallet.signTx(tx.txHex, true);
    const hash = await wallet.submitTx(signed);

    console.log("✏️ NFT state updated: Tx Id:", hash);
}

// ------------------------------------------------------------
// 3. Seal NFT
// ------------------------------------------------------------

export async function sealEditableNft(
    walletFile: string,
    policyId: string,
    tokenName: string,
    payload: string,
) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const ownerPkh = resolvePaymentKeyHash(changeAddr);

    const assetNameHex = stringToHex(tokenName);
    const { script, address } = loadStateScript(policyId, assetNameHex);

    const stateUtxos = await provider.fetchAddressUTxOs(address);
    const stateUtxo = stateUtxos[0];
    if (!stateUtxo) throw new Error("No state UTxO");

    const collateral = await wallet.getCollateral();
    const walletUtxos = await provider.fetchAddressUTxOs(changeAddr);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        .spendingPlutusScriptV3()
        .txIn(
            stateUtxo.input.txHash,
            stateUtxo.input.outputIndex,
            stateUtxo.output.amount,
            address,
        )
        .txInInlineDatumPresent()
        .txInRedeemerValue(mConStr1([]))
        .txInScript(script)

        .txOut(address, stateUtxo.output.amount)
        .txOutInlineDatumValue(
            mConStr0([ownerPkh, { alternative: 1, fields: [] }, payload]),
        )

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

    console.log("🔒 NFT sealed: Tx Id:", hash);
}
