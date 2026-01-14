// ------------------------------------------------------------
// CLI entrypoint for Editable NFT
// ------------------------------------------------------------

import {
    mintEditableNft,
    updateEditableNft,
    transferEditableNft,
    sealEditableNft,
} from "./editable-nft.ts";

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
    const [command, ...args] = Deno.args;

    if (!command) {
        console.log(
            "Usage:\n\n" +
            "  mint <wallet.json> <token_name> <payload>\n" +
            "  update <wallet.json> <policyId> <token_name> <payload>\n" +
            "  transfer <wallet.json> <policyId> <token_name> <newOwnerPkh>\n" +
            "  seal <wallet.json> <policyId> <token_name>\n",
        );
        return;
    }

    // ----------------------------------------------------------
    // Mint / Buy NFT (with initial payload)
    // ----------------------------------------------------------
    if (command === "mint") {
        if (args.length !== 3) {
            console.error(
                "Usage:\n" +
                "  deno run -A editable-nft-cli-test.ts mint <wallet.json> <token_name> <payload>",
            );
            Deno.exit(1);
        }

        const [walletFile, tokenName, payload] = args;
        await mintEditableNft(walletFile, tokenName, payload);
        return;
    }

    // ----------------------------------------------------------
    // Update / Edit NFT payload
    // ----------------------------------------------------------
    if (command === "update") {
        if (args.length !== 5) {
            console.error(
                "Usage:\n" +
                "  deno run -A editable-nft-cli-test.ts update <wallet.json> <policyId> <token_name> <updatedOwnerPkh> <updatedPayload>",
            );
            Deno.exit(1);
        }

        const [walletFile, policyId, tokenName, ownerPhk, payload] = args;
        await updateEditableNft(walletFile, policyId, tokenName, ownerPhk, payload);
        return;
    }

    // ----------------------------------------------------------
    // Seal NFT
    // ----------------------------------------------------------
    if (command === "seal") {
        if (args.length !== 4) {
            console.error(
                "Usage:\n" +
                "  deno run -A editable-nft-cli-test.ts seal <wallet.json> <policyId> <token_name> <payload>",
            );
            Deno.exit(1);
        }

        const [walletFile, policyId, tokenName, payload] = args;
        await sealEditableNft(walletFile, policyId, tokenName, payload);
        return;
    }

    // ----------------------------------------------------------
    // Unknown command
    // ----------------------------------------------------------
    console.error("Unknown command");
    Deno.exit(1);
}

// ------------------------------------------------------------
// Run
// ------------------------------------------------------------

if (import.meta.main) {
    main();
}
