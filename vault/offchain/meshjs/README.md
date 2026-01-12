# Vault Contract Offchain (MeshJS)

This directory contains the offchain code for interacting with the Vault Aiken contract using MeshJS (Deno).

## Prerequisites

- **Deno**: Install Deno 1.40+.
- **Cardano Node**: Access to Preprod (using Koios provider by default).
- **Wallet**: The app uses `wallet_0.txt` by default. You can generate it using the `prepare` command.

## Installation

The project uses a `deno.json` import map. No manual `npm install` is required for Deno. Dependencies are cached on first run.

## Usage

Use `deno task` for convenience:

### 1. Initialize

Prints the script address derived from the contract blueprint.

```bash
deno task init
```

### 2. Lock Funds

Locks funds with a ~100 year lock time (Infinite).

```bash
deno task lock 5000000
```

This locks 5 ADA.

To lock funds that are immediately withdrawable (with a past timestamp), usage raw command:

```bash
deno run -A --unstable-detect-cjs vault.ts lock-withdrawable 5000000
```

### 3. Withdraw

Initiates the withdrawal process. This sets the lock time to "Now" and starts the waiting period.

```bash
deno task withdraw <UTXO_TX_HASH>
```

Example:

```bash
deno task withdraw e9291acc9b4c95363f7d0d33c77e44878c1da3e40dc9cfc5115f011274051bf9
```

### 4. Finalize

Claims the funds after the waiting period (default 60s) has passed.
The command will automatically wait if the time hasn't passed yet.

```bash
deno task finalize <WITHDRAW_TX_HASH>
```

Example:

```bash
deno task finalize 5e12ac6562650d28b187a8684900dbd966d90597a93dfa56cecd84f237ac83c4
```

### 5. Cancel

Cancels a locked UTxO and returns funds to the owner.

```bash
deno task cancel <LOCKED_TX_HASH>
```

### 6. Prepare Wallets

Generates `wallet_X.txt` files.

```bash
deno task prepare 4
```

## Troubleshooting

- **BadInputsUTxO / ValueNotConserved**:
  If you run commands in quick succession (e.g., `lock` then immediately `lock-withdrawable`), you may encounter errors because the Koios provider hasn't indexed the previous transaction yet.
  **Solution**: Wait 20-60 seconds between transactions.

- **UTxO Not Found**:
  Same as above. Wait for the transaction to be confirmed and indexed.

- **OutsideValidityIntervalUTxO**:
  Ensure your system clock is synced or rely on `getNetworkSlot` (which is now implemented in the code) to avoid validity interval issues.

- **Wallet Not Found**:
  The app looks for `wallet_0.txt` in the `vault/offchain/meshjs` directory. Ensure your mnemonic file is named correctly or run `deno task prepare` to generate one.

## Utilities

- **Check Balances**:
  ```bash
  deno run -A --unstable-detect-cjs check_balances.ts
  ```
