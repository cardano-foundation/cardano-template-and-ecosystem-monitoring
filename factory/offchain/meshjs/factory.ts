import {
    builtinByteString,
    KoiosProvider,
    MeshTxBuilder,
    MeshWallet,
    resolvePaymentKeyHash,
    resolveScriptHash,
    scriptHash,
    serializePlutusScript,
    stringToHex,
    mConStr0,
    deserializeDatum,
    Asset,
    hexToString
} from "@meshsdk/core";

import { applyParamsToScript } from "@meshsdk/core-csl";

import blueprint from "../../onchain/aiken/plutus.json" with { type: "json" };

// ------------------------------------------------------------
// Config
// ------------------------------------------------------------

const NETWORK = "preprod";
const NETWORK_ID = 0;

// ------------------------------------------------------------
// Wallet helper
// ------------------------------------------------------------

function loadWalletFromFile(path: string): MeshWallet {
    const mnemonic = JSON.parse(Deno.readTextFileSync(path));
    const provider = new KoiosProvider(NETWORK);

    return new MeshWallet({
        networkId: NETWORK_ID,
        fetcher: provider,
        submitter: provider,
        key: { type: "mnemonic", words: mnemonic },
    });
}

// ------------------------------------------------------------
// Script helpers
// ------------------------------------------------------------

function getScriptAddress(compiled: string) {
    const { address } = serializePlutusScript(
        { code: compiled, version: "V3" },
        undefined,
        NETWORK_ID,
    );
    return address;
}

function getValidator(name: string) {
    const v = blueprint.validators.find(v => v.title.startsWith(name));
    if (!v) throw new Error(`Validator not found: ${name}`);
    return v.compiledCode;
}

// ------------------------------------------------------------
// Load scripts (derived only from owner / product id)
// ------------------------------------------------------------

function getFactoryScriptDetails(ownerPkh: string) {
    const script = applyParamsToScript(
        getValidator("factory"),
        [builtinByteString(ownerPkh)],
        "JSON",
    );

    return {
        script,
        policyId: resolveScriptHash(script, "V3"),
    };
}

function getProductScriptDetails(ownerPkh: string, productId: string) {
    const factory = getFactoryScriptDetails(ownerPkh);

    const script = applyParamsToScript(
        getValidator("product"),
        [
            builtinByteString(ownerPkh),
            scriptHash(factory.policyId),
            builtinByteString(stringToHex(productId)),
        ],
        "JSON",
    );

    return {
        script,
        address: getScriptAddress(script),
        factoryPolicyId: factory.policyId,
    };
}

// ------------------------------------------------------------
// createProduct
// ------------------------------------------------------------

export async function createProduct(
    walletFile: string,
    productId: string,
    tag: string,
) {
    const wallet = loadWalletFromFile(walletFile);
    const provider = new KoiosProvider(NETWORK);

    const changeAddr = await wallet.getChangeAddress();
    const ownerPkh = resolvePaymentKeyHash(changeAddr);
    console.log("ownerPkh: ",ownerPkh)

    const factory = getFactoryScriptDetails(ownerPkh);
    const product = getProductScriptDetails(ownerPkh, productId);

    const utxos = await provider.fetchAddressUTxOs(changeAddr);
    const collateral = await wallet.getCollateral();

    const productDatum = mConStr0([tag]);

    const tx = new MeshTxBuilder({
        fetcher: provider,
        submitter: provider,
        evaluator: provider,
    }).setNetwork(NETWORK);

    await tx
        // mint Product NFT from Factory
        .mintPlutusScriptV3()
        .mint("1", factory.policyId, stringToHex(productId))
        .mintingScript(factory.script)
        .mintRedeemerValue(mConStr0([productId]))

        // lock Product UTxO at Product contract
        .txOut(
            product.address,
            [
                {
                    unit: factory.policyId + stringToHex(productId),
                    quantity: "1",
                },
            ],
        )
        .txOutInlineDatumValue(productDatum)

        // signer & collateral
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

    console.log("Product contract created");
    console.log("Owner PKH:", ownerPkh);
    console.log("Factory policy:", factory.policyId);
    console.log("Product contract address:", product.address);
    console.log("Tx hash:", hash);
}

// ------------------------------------------------------------
// getProducts (derived from owner)
// ------------------------------------------------------------
export async function getProducts(ownerPkh: string) {
    const factory = getFactoryScriptDetails(ownerPkh);

    const url =
        `https://preprod.koios.rest/api/v1/policy_asset_list` +
        `?_asset_policy=${factory.policyId}`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            accept: "application/json",
        },
    });

    if (!response.ok) {
        throw new Error(`Koios error: ${response.statusText}`);
    }

    const assets = await response.json();

    const products = assets.map((asset: any) => ({
        productId: hexToString(asset.asset_name),          // hex asset name
        policyId: factory.policyId,
        fingerprint: asset.fingerprint,
    }));

    console.log("Products fetched:", products);
}


// ------------------------------------------------------------
// getTag (derived from owner + product id)
// ------------------------------------------------------------

export async function getTag(ownerPkh: string, productId: string) {
    const provider = new KoiosProvider(NETWORK);
    const product = getProductScriptDetails(ownerPkh, productId);

    const utxos = await provider.fetchAddressUTxOs(product.address);

    if (!utxos.length || !utxos[0].output.plutusData) { //just picking first product for this reference code
        throw new Error("Product datum not found");
    }

    const datum = deserializeDatum(utxos[0].output.plutusData);
    return datum.fields[0].bytes;
}

// ------------------------------------------------------------
// getFactory (derived from owner)
// ------------------------------------------------------------

export function getFactory(ownerPkh: string) {
    const factory = getFactoryScriptDetails(ownerPkh);
    return {
        ownerPkh,
        policyId: factory.policyId,
    };
}

// ------------------------------------------------------------
// CLI entrypoint
// ------------------------------------------------------------

async function main() {
    const [command, ...args] = Deno.args;

    if (!command) {
        console.log(
            "Usage:\n\n" +
            "  create-product <wallet.json> <product_id> <tag>\n" +
            "  get-products <owner_pkh>\n" +
            "  get-tag <owner_pkh> <product_id>\n" +
            "  get-factory <owner_pkh>\n",
        );
        return;
    }

    if (command === "create-product") {
        if (args.length !== 3) {
            console.error(
                "Usage:\n" +
                "  deno run -A factory_product_offchain.ts " +
                "create-product <wallet.json> <product_id> <tag>",
            );
            Deno.exit(1);
        }

        const [walletFile, productId, tag] = args;
        await createProduct(walletFile, productId, tag);
        return;
    }

    if (command === "get-products") {
        if (args.length !== 1) {
            console.error(
                "Usage:\n" +
                "  deno run -A factory_product_offchain.ts " +
                "get-products <owner_pkh>",
            );
            Deno.exit(1);
        }

        const [ownerPkh] = args;
        await getProducts(ownerPkh);
        return;
    }

    if (command === "get-tag") {
        if (args.length !== 2) {
            console.error(
                "Usage:\n" +
                "  deno run -A factory_product_offchain.ts " +
                "get-tag <owner_pkh> <product_id>",
            );
            Deno.exit(1);
        }

        const [ownerPkh, productId] = args;
        console.log("Product tag:", await getTag(ownerPkh, productId));
        return;
    }

    if (command === "get-factory") {
        if (args.length !== 1) {
            console.error(
                "Usage:\n" +
                "  deno run -A factory_product_offchain.ts " +
                "get-factory <owner_pkh>",
            );
            Deno.exit(1);
        }

        const [ownerPkh] = args;
        console.log(getFactory(ownerPkh));
        return;
    }

    console.error("Unknown command");
    Deno.exit(1);
}

if (import.meta.main) {
    main();
}
