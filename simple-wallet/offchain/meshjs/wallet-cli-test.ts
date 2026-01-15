// ------------------------------------------------------------
// CLI entrypoint
// ------------------------------------------------------------

import {addFunds, createIntent, executeIntent, withdrawAll,} from "./wallet.ts";

async function main() {
    const [command, ...args] = Deno.args;

    if (!command) {
        console.log(
            "Usage:\n\n" +
            "  create-intent <wallet.json> <recipient> <lovelace> <data>\n" +
            "  fund <wallet.json> <lovelace>\n" +
            "  execute <wallet.json>\n" +
            "  withdraw <wallet.json>\n",
        );
        return;
    }

    if (command === "create-intent") {
        if (args.length !== 4) {
            console.error(
                "Usage:\n" +
                "  deno run -A wallet.ts create-intent <wallet.json> <recipient> <lovelace> <data>",
            );
            Deno.exit(1);
        }

        const [walletFile, recipient, lovelace, data] = args;
        await createIntent(walletFile, recipient, lovelace, data);
        return;
    }

    if (command === "add-funds") {
        if (args.length !== 2) {
            console.error(
                "Usage:\n" +
                "  deno run -A wallet.ts fund <wallet.json> <lovelace>",
            );
            Deno.exit(1);
        }

        const [walletFile, lovelace] = args;
        await addFunds(walletFile, lovelace);
        return;
    }

    if (command === "execute") {
        if (args.length !== 1) {
            console.error(
                "Usage:\n" +
                "  deno run -A wallet.ts execute <wallet.json>",
            );
            Deno.exit(1);
        }

        const [walletFile] = args;
        await executeIntent(walletFile);
        return;
    }

    if (command === "withdraw") {
        if (args.length !== 1) {
            console.error(
                "Usage:\n" +
                "  deno run -A wallet.ts withdraw <wallet.json>",
            );
            Deno.exit(1);
        }

        const [walletFile] = args;
        await withdrawAll(walletFile);
        return;
    }

    console.error("Unknown command");
    Deno.exit(1);
}

if (import.meta.main) {
    main();
}
