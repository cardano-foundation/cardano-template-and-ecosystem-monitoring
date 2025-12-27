## 💠 Deno + Lucid Evolution (Off‑chain auction)

This repo includes multiple Deno + Lucid Evolution off‑chain examples. Quick setup and run steps for the Lucid Evolution implementations:

Prerequisites

- Deno v2+ installed (https://deno.land)
- Aiken (to produce onchain Aiken artifact `plutus.json`) if you will run examples that require compiled onchain scripts
- (Optional/local tests) Yaci DevKit for a local node / Yaci viewer

Build on‑chain artifacts

1. For each example that uses Aiken, compile the onchain contract:
   cd <example>/onchain/aiken && aiken build
   Example: cd auction/onchain/aiken && aiken build

Prepare wallets, fund, run

- General notes:
  - Use Deno allow-all shorthand `-A` (examples use `deno run -A ...`). More restrictive flags: --allow-net --allow-read --allow-write --allow-env.
  - The scripts write seed files (wallet\_\*.txt or wallet.txt). Keep them private.

Auction (Lucid Evolution)

- Files:
  - [auction/offchain/lucid-evolution/auction.ts](auction/offchain/lucid-evolution/auction.ts) — functions: [`prepare`](auction/offchain/lucid-evolution/auction.ts), [`initAuction`](auction/offchain/lucid-evolution/auction.ts), [`bidAuction`](auction/offchain/lucid-evolution/auction.ts)
- Commands (run from auction/offchain/lucid-evolution):
  - Prepare 3 wallets: deno run -A auction.ts prepare 3
  - Fund wallet_0 with tADA (Preprod)
  - Initialize auction with starting bid 3 ADA: deno run -A auction.ts init 3000000
  - Place a bid: deno run -A auction.ts bid <TX_ID> <NEW_BID_LOVELACE>

Upgradable Proxy (Lucid Evolution)

- Files:
  - [upgradable-proxy/offchain/lucid-evolution/proxy.ts](upgradable-proxy/offchain/lucid-evolution/proxy.ts) — functions: [`prepare`](upgradable-proxy/offchain/lucid-evolution/proxy.ts), [`initProxy`](upgradable-proxy/offchain/lucid-evolution/proxy.ts), [`mint`](upgradable-proxy/offchain/lucid-evolution/proxy.ts), [`changeVersion`](upgradable-proxy/offchain/lucid-evolution/proxy.ts)
  - [upgradable-proxy/offchain/lucid-evolution/helper.ts](upgradable-proxy/offchain/lucid-evolution/helper.ts)
  - [upgradable-proxy/offchain/lucid-evolution/types.ts](upgradable-proxy/offchain/lucid-evolution/types.ts)
- Commands (run from upgradable-proxy/offchain/lucid-evolution):
  - Prepare wallet: deno run -A proxy.ts prepare
  - Fund the printed wallet address with tADA
  - Initialize proxy (mints state token & creates proxy UTxO): deno run -A proxy.ts init
  - Mint via proxy: deno run -A proxy.ts mint <tokenUnit>
  - Change logic version: deno run -A proxy.ts change-version <tokenUnit>

Other Lucid Evolution examples

- See each example folder under _/offchain/lucid-evolution/_ for the script and available commands (use `deno run -A <script> --help` style inspection).
- Example files: [auction/offchain/lucid-evolution/auction.ts](auction/offchain/lucid-evolution/auction.ts), [upgradable-proxy/offchain/lucid-evolution/proxy.ts](upgradable-proxy/offchain/lucid-evolution/proxy.ts)

Troubleshooting

- If `plutus.json` missing: run `aiken build` in the corresponding onchain folder (e.g. auction/onchain/aiken).
- If no UTxO found for a token unit: wait ~20s for indexing and retry.
- If wallet files already exist and you want fresh seeds, remove wallet\_\*.txt or wallet.txt before `prepare`.
