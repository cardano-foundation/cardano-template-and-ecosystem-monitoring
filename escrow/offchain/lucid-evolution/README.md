# Escrow Contract Off-chain Code (Lucid Evolution)

This directory contains the off-chain code for interacting with the Escrow smart contract on the Cardano Preprod testnet. It uses [Lucid Evolution](https://github.com/Anastasia-Labs/lucid-evolution) and [Deno](https://deno.land/).

## Prerequisites

- **Deno**: Ensure you have Deno installed. [Installation Guide](https://docs.deno.com/runtime/manual)

## Project Structure

- **`escrow.ts`**: The main CLI script that handles user commands and orchestrates contract interactions.
- **`types.ts`**: Contains TypeScript definitions and Data schemas (Aiken types) for the contract.
- **`lib/utils.ts`**: Helper functions for wallet management, Lucid setup, and local state storage.
- **`escrow_store.json`**: A local JSON file used to track the state of initiated escrows (TxHash, Initiator, State, etc.).
- **`deno.json`**: Configuration file defining available tasks.

## Setup

1.  **Install Deno**: If not already installed.
2.  **Navigate to directory**:
    ```bash
    cd escrow/offchain/lucid-evolution
    ```

## Usage

You can run commands using `deno task <command>`.

### 1. Prepare Wallets

Generates new wallet seed phrases and saves them to `wallet_N.txt` files.

```bash
deno task prepare <count>
# Example: Generate 5 wallets
deno task prepare 5
```

> **Important**: After preparing, you must fund the first wallet (`wallet_0.txt`) with tADA from the [Cardano Testnet Faucet](https://docs.cardano.org/cardano-testnet/tools/faucet).

### 2. Check Balances

View the address and balance of your generated wallets.

```bash
deno task balances
```

### 3. Initiate Escrow

The initiator locks assets into the contract.

```bash
deno task initiate <walletIndex> <lovelaceAmount>
# Example: Wallet 1 initiates with 10 ADA
deno task initiate 1 10000000
```

### 4. List Active Escrows

View the status of all locally tracked escrows and check if they exist on-chain.

```bash
deno task list-utxos
```

### 5. Deposit (Recipient)

The recipient deposits their side of the trade.

```bash
deno task deposit <txHash> <walletIndex> <lovelaceAmount>
# Example: Wallet 0 deposits 5 ADA to the escrow with specific TxHash
deno task deposit <txHash> 0 5000000
```

### 6. Complete Trade

Finalize the trade. This swaps the assets between the initiator and the recipient.

```bash
deno task complete <txHash>
```

### 7. Cancel Trade

Cancel the escrow and refund the assets to the initiator (if in Initiation state) or both parties (if in Active state).

```bash
deno task cancel <txHash> <walletIndex>
# Example: Wallet 1 cancels the trade
deno task cancel <txHash> 1
```

## Testing Workflow

Follow these steps to test the full lifecycle of the contract:

1.  **Prepare and Fund**:

    ```bash
    deno task prepare 5
    # Fund wallet_0 address with tADA from faucet
    deno task balances # Verify funds
    ```

2.  **Distribute Funds** (Optional helper):
    If you need to send funds from Wallet 0 to Wallet 1:

    ```bash
    deno task transfer 0 1 20000000 # Send 20 ADA to Wallet 1
    ```

3.  **Initiate**:

    ```bash
    deno task initiate 1 10000000
    # Copy the TxHash from the output
    ```

4.  **Verify State**:

    ```bash
    deno task list-utxos
    ```

5.  **Deposit**:

    ```bash
    deno task deposit <TxHash_From_Step_3> 0 5000000
    ```

6.  **Complete**:

    ```bash
    deno task complete <TxHash_From_Step_3>
    ```

7.  **Cancel (Alternative Path)**:
    If you want to test cancellation instead of completion:
    ```bash
    deno task cancel <TxHash_From_Step_3> 1
    ```
