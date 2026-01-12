# Vault Contract Offchain (Lucid Evolution)

This directory contains the offchain code for interacting with the Vault Aiken contract using Lucid Evolution (Deno).

## Prerequisites

- **Deno**: Install Deno 1.40+.
- **Cardano Node**: Access to Preprod (using Koios provider by default).
- **Wallet**: The app uses `wallet_0.txt` by default. You can generate it using the `prepare` command.

## Installation

The project uses a `deno.json` import map. No manual `npm install` is required for Deno. Dependencies are cached on first run.

## Usage

You can run the commands using `deno task` (convenience scripts defined in `deno.json`) or directly with `deno run`.

### Quick Tasks

```bash
deno task init              # Initialize and print script address
deno task prepare <COUNT>   # Generate N wallets (e.g. deno task prepare 1)
deno task lock <AMOUNT>     # Lock Amount (Lovelace)
deno task withdraw <TX>     # Withdraw (Start Timer)
deno task finalize <TX>     # Finalize (Claim)
deno task cancel <TX>       # Cancel (Reset)
```

### Manual Execution

```bash
deno run -A --unstable-detect-cjs vault.ts <COMMAND> [ARGS]
```

### Technical Details & Time Handling

To ensure robust operation across distributed systems, this implementation includes specific time synchronization logic:

1.  **Network Time Synchronization**:
    Instead of relying on the local system clock (which may drift), the code fetches the latest block time from the Provider (Koios/Blockfrost) using `getNetworkTime()`. This ensures that validity intervals constructed in transactions align precisely with the blockchain's view of time.

2.  **Automatic Waiting**:
    The contract enforces a 60-second wait period (`WAIT_TIME`) between `withdraw` and `finalize`.

    - If you run `finalize` too early, the script detects this by comparing the current network time with the stored `lockTime + WAIT_TIME`.
    - Instead of failing, it calculates the remaining duration and uses `setTimeout` to pause execution until the exact moment the funds become claimable.

3.  **Validity Intervals**:
    - **Withdraw**: Sets a validity range of `[now, now + 2min]` and updates the UTxO datum with `now`.
    - **Finalize**: Sets a validity range of `[validAfter + 1s, now + 3min]`. The `validFrom` is strictly checked to be greater than the wait time expiry.

### Commands Detail

1.  **Initialize**
    Prints the script address derived from the contract blueprint.

    ```bash
    deno task init
    ```

2.  **Prepare Wallets**
    Generates wallet files (e.g., `wallet_0.txt`) with seed phrases if they don't exist.

    ```bash
    deno task prepare 1
    ```

3.  **Lock Funds (Infinite)**
    Locks funds with a ~100 year lock time. These funds cannot be finalized immediately. You must first `withdraw` to start the countdown.

    ```bash
    deno task lock 5000000
    ```

4.  **Lock Funds (Withdrawable Shortcut)**
    Locks funds with a timestamp in the _past_ (100 seconds ago). These funds are immediately ready for `finalize`.

    **Note**: This is useful for testing without waiting.

    ```bash
    deno run -A --unstable-detect-cjs vault.ts lock-withdrawable 5000000
    ```

5.  **Cancel**
    Cancels a locked UTxO by resetting it to a state without the withdrawal datum, effectively stopping any countdown.

    ```bash
    deno task cancel <TX_HASH>
    ```

6.  **Withdraw**
    Transitions a "Locked" UTxO to a "Withdrawing" state by updating the datum to the current network time. This starts the 60-second timer.

    ```bash
    deno task withdraw <TX_HASH>
    ```

7.  **Finalize**
    Claims the funds from a UTxO that has completed its wait time.

    **Important**:  
    This command verifies that the network time is valid. The contract owner must wait for the specified period (default 60s) after `withdraw` before this command will succeed.
    **Auto-Wait**: If run too early, the CLI will automatically wait (sleep) for the remaining time before submitting the transaction.

    ```bash
    deno task finalize <TX_HASH>
    ```

### Troubleshooting

- **BadInputsUTxO / ValueNotConserved**:
  If you run commands in quick succession (e.g., `lock` then immediately `lock-withdrawable`), you may encounter errors because the UTxO set hasn't refreshed on the provider.
  **Solution**: Wait 10-20 seconds between transactions or retry the command.

- **Wallet Not Found**:
  The app looks for `wallet_0.txt` in the current directory. Use `prepare` to generate it.
