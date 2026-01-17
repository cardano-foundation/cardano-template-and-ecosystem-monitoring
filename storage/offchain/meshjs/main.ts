import { parseArgs, runDelete, runLock, runSet } from "./src/lib.ts";

async function main() {
  const [cmd, ...rest] = Deno.args;

  if (!cmd || ["-h", "--help", "help"].includes(cmd)) {
    console.log(`Usage:
  deno task lock   -- [options]
  deno task set    -- [options]
  deno task delete -- [options]

Options (lock):
  --amount <lovelace>         default: 2000000
  --key-utf8 <text>           required unless --key-hex
  --value-utf8 <text>         required unless --value-hex
  --key-hex <hexbytes>
  --value-hex <hexbytes>

Options (set):
  --key-utf8 / --key-hex
  --value-utf8 / --value-hex
  --utxo <txHash#index>       optional

Options (delete):
  --utxo <txHash#index>       optional
Environment:
  YACI_URL                    default: https://yaci-node.meshjs.dev/api/v1/
  BLOCKFROST_PROJECT_ID       optional
  NETWORK_ID                  default: 0
  ROOT_KEY_BECH32             OR MNEMONIC (24 words)
`);
    return;
  }

  const opts = parseArgs(rest);

  switch (cmd) {
    case "lock":
      await runLock(opts);
      return;
    case "set":
      await runSet(opts);
      return;
    case "delete":
      await runDelete(opts);
      return;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

await main();
