# HTLC Offchain (Lucid Evolution)

This folder contains an off-chain TypeScript CLI using Lucid (via the Evolution SDK) to interact with the HTLC Plutus validator compiled in `../../onchain/aiken/plutus.json`.

**Purpose:** provide simple developer tooling to prepare test wallets, lock funds into the HTLC, claim with a preimage, and refund after expiration.

**Files:**

- `htlc.ts` — main CLI script with commands: `prepare`, `init`, `claim`, `refund`.
- `check_balances.ts` — dynamically checks balances for all `wallet_*.txt` files.
- `show_addresses.ts` — displays addresses for all `wallet_*.txt` files.
- `fund_wallet_1.ts` — utility to fund Wallet 1 from Wallet 0 for collateral.
- `deno.json` — convenience tasks for `deno` (run/watch/commands).

**Prerequisites**

- Deno (tested with Deno 2.6.3)
- Internet access to the configured Koios endpoint (default: Preprod Koios)
- Testnet tADA for `wallet_0` to cover fees and collateral

Quick setup

1. Change to this folder:

```bash
cd htlc/offchain/lucid-evolution
```

2. Install any Deno remote dependencies (optional; Deno will fetch on first run):

```bash
deno cache htlc.ts
```

3. Prepare seed phrases (creates `wallet_0.txt`, `wallet_1.txt`, ...):

```bash
deno run -A htlc.ts prepare 5
```

4. Fund `wallet_0` (first printed address) with tADA from a faucet or testnet funding service.

Usage

- Prepare wallets:

```bash
deno run -A htlc.ts prepare <count>
```

- Initialize / lock funds to HTLC (owner submits tx; provide lovelace amount and secret preimage; `recipientIndex` picks which prepared wallet is recipient):

```bash
deno run -A htlc.ts init <lovelace> <secret> [recipientIndex]
```

Example:

```bash
deno run -A htlc.ts init 1000000 mySecret 1
```

- Claim HTLC (recipient uses preimage to redeem). Provide the tx hash returned by `init`:

```bash
deno run -A htlc.ts claim <txHash> <preimage>
```

- Refund HTLC (owner calls after expiration):

```bash
deno run -A htlc.ts refund <txHash>
```

deno.json tasks

- `deno task prepare` — prepares sample wallets (configured in `deno.json`)
- `deno task balances` — check balances of all prepared wallets
- `deno task show-addresses` — show addresses of all prepared wallets
- `deno task fund-collateral` — send 10 ADA from Wallet 0 to Wallet 1
- `deno task init` — lock 10 ADA with secret "mySecret"
- `deno task claim` — claim funds (requires editing `deno.json` with txHash)
- `deno task refund` — refund funds (requires editing `deno.json` with txHash)

Implementation notes & caveats

- The script uses the `preprod` Koios endpoint by default. You may change the provider URL in `htlc.ts` to target other networks.
- `prepare` writes `wallet_<n>.txt` files containing mnemonic seed phrases. Keep them secure; these are full-signing keys.
- `init` selects `wallet_0` to submit transactions. Ensure that file exists and the associated address has tADA.
- The claim/refund commands locate the script UTXO by tx hash. Some provider responses may return inline datum formats that require retrying different output indexes or listing the script UTXOs; the CLI includes fallbacks but you may need to inspect the transaction on a block explorer if a UTXO isn't found.

Troubleshooting

- Tx submission failing with validity or slot errors: remove hard-coded `validFrom`/`validTo` or ensure system clock and provider are in sync. The current script lets the provider set defaults.
- `No UTXOs found for transaction ID`:
  - Check the explorer link printed by `init` to find which output index holds the script UTXO.
  - Try `deno run -A htlc.ts claim <txHash> <preimage>` again; the script will attempt common fallbacks.

Security

- These scripts are for development and testing only. Do NOT use these mnemonics or the example code on mainnet without proper security and audits.

Further work / improvements

- Add CLI flags for provider URL / network selection.
- Add explicit output-index parameter to `claim` / `refund` to target specific outputs.
- Improve Koios parsing fallback for inline datums and differing response shapes.

Contact

- If you want me to extend this README or add specific examples (detailed explorer inspection steps, sample outputs, or a test harness), tell me which part you'd like next.
