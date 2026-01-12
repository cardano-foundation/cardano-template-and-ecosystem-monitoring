# Vault Contract Offchain (MeshJS)

This directory contains the offchain code for interacting with the Vault Aiken contract using MeshJS (Deno).

## Prerequisites

- **Deno**: Install Deno 1.40+.
- **Cardano Node**: Access to Preprod (using Koios provider by default).
- **Wallet**: A `wallet.txt` (mnemonic) file is expected in this directory. If not present, the app may fall back to generating one or failing, but explicit file naming prevents accidental usage of wrong wallets.

## Installation

The project uses a `deno.json` import map. No manual `npm install` is required for Deno. Dependencies are cached on first run.

## Usage

Run the CLI using `deno run`:

```bash
deno run -A --unstable-detect-cjs vault.ts <COMMAND> [ARGS]
```

### Commands

1.  **Initialize**
    Prints the script address derived from the contract blueprint.

    ```bash
    deno run -A --unstable-detect-cjs vault.ts init
    ```

2.  **Lock Funds (Infinite)**
    Locks funds with a ~100 year lock time. These funds can only be cancelled/withdrawn by manual intervention (or `cancel` command).

    ```bash
    deno run -A --unstable-detect-cjs vault.ts lock <LOVELACE_AMOUNT>
    # Example
    deno run -A --unstable-detect-cjs vault.ts lock 5000000
    ```

3.  **Lock Funds (Withdrawable Shortcut)**
    Locks funds with a timestamp in the _past_ (100 seconds ago). These funds are immediately ready for `finalize`.

    **Note**: This is useful for testing the happy path without waiting.

    ```bash
    deno run -A --unstable-detect-cjs vault.ts lock-withdrawable <LOVELACE_AMOUNT>
    ```

4.  **Cancel**
    Cancels a locked UTxO and returns funds to the contract owner (or resets the state).

    ```bash
    deno run -A --unstable-detect-cjs vault.ts cancel <TX_HASH>
    ```

5.  **Withdraw**
    Transitions a "Locked" UTxO to a "Withdrawing" state (starts the timer).

    ```bash
    deno run -A --unstable-detect-cjs vault.ts withdraw <TX_HASH>
    ```

6.  **Finalize**
    Claims the funds from a UTxO that has completed its wait time.

    **Important**:  
    This command verifies that the network time is valid. The contract owner must wait for the specified period (default 60s, or past if using `lock-withdrawable`) before this command will succeed. If run too early, the CLI will output the required wait time.

    ```bash
    deno run -A --unstable-detect-cjs vault.ts finalize <TX_HASH>
    ```

### Troubleshooting

- **BadInputsUTxO / ValueNotConserved**:
  If you run commands in quick succession (e.g., `lock` then immediately `lock-withdrawable`), you may encounter errors because the UTxO set hasn't refreshed.
  **Solution**: Wait 10-20 seconds between transactions or retry the command.

- **Wallet Not Found**:
  The app looks for `wallet.txt` in the `vault/offchain/meshjs` directory. Ensure your mnemonic file is named correctly.

## Utilities

- **Check Balances**:
  ```bash
  deno run -A --unstable-detect-cjs check_balances.ts
  ```
