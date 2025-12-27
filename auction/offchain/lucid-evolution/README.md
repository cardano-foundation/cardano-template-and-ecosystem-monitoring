## 💠 Deno + Lucid Evolution (Off‑chain auction)

This repo includes Auction Deno + Lucid Evolution off‑chain examples. Quick setup and run steps for the Lucid Evolution implementations:

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

- Commands (run from auction/offchain/lucid-evolution):
  - Prepare 3 wallets: deno run -A auction.ts prepare 3
  - Fund wallet_0 with tADA (Preprod)
  - Initialize auction with starting bid 3 ADA: deno run -A auction.ts init 3000000
  - Place a bid: deno run -A auction.ts bid <TX_ID> <NEW_BID_LOVELACE>

Troubleshooting

- If `plutus.json` missing: run `aiken build` in the corresponding onchain folder (e.g. auction/onchain/aiken).
- If no UTxO found for a token unit: wait ~20s for indexing and retry.
- If wallet files already exist and you want fresh seeds, remove wallet\_\*.txt or wallet.txt before `prepare`.
