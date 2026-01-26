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

## Wallet Management

Before running scenarios, you need wallets with funds.

1.  **Generate Wallets**: Creates local `wallet_N.txt` files.
    ```bash
    deno task prepare 5
    ```
2.  **Fund Wallet 0**:
    - Run `deno task balances` to get the address of **Wallet 0**.
    - Request tADA from the [Cardano Testnet Faucet](https://docs.cardano.org/cardano-testnet/tools/faucet) to that address.
3.  **Distribute Funds**:
    - Send some ADA to **Wallet 1** (and others) so they can act as counterparties.
    ```bash
    # Send 50 ADA from Wallet 0 to Wallet 1
    deno task transfer 0 1 50000000
    ```

## Test Scenarios

There are three main scenarios to test the contract logic.

### Scenario A: Successful Trade (Happy Path)

In this scenario, two parties successfully exchange assets.

1.  **Initiate Escrow (Wallet 1)**

    - **Action**: Wallet 1 sends 10 ADA to the script address.
    - **On-Chain**: A UTXO is created at the script address with the `Initiation` datum state, containing the Initiator's public key hash and asset details.

    ```bash
    deno task initiate 1 10000000
    ```

    - _Copy the **TxHash** from the output for the next steps._

2.  **Deposit (Wallet 0)**

    - **Action**: Wallet 0 finds the UTXO and deposits 5 ADA.
    - **On-Chain**: The previous UTXO is spent. A new UTXO is created at the same script address containing both amounts (15 ADA) with the `ActiveEscrow` datum state, now recording both parties' details.

    ```bash
    deno task deposit <TxHash> 0 5000000
    ```

3.  **Complete Trade**
    - **Action**: Both parties sign the transaction (simulated in script).
    - **On-Chain**: The contract validates the signatures and ensures assets are distributed according to the agreement (Wallet 1 gets 5 ADA, Wallet 0 gets 10 ADA).
    ```bash
    deno task complete <TxHash>
    ```

---

### Scenario B: Cancellation BEFORE Deposit

The initiator changes their mind before anyone accepts the offer.

1.  **Initiate Escrow (Wallet 1)**

    ```bash
    deno task initiate 1 10000000
    ```

    - _Copy the **TxHash**._

2.  **Cancel (Wallet 1)**
    - **Action**: Wallet 1 spends the UTXO to refund themselves.
    - **On-Chain**: The contract checks if the spender is the `Initiator` recorded in the datum.
    - **Result**: 10 ADA is returned to Wallet 1.
    ```bash
    deno task cancel <TxHash> 1
    ```

---

### Scenario C: Cancellation AFTER Deposit

The trade is active, but the parties decide to cancel (or it expires/is faulty).

1.  **Initiate Escrow (Wallet 1)**

    ```bash
    deno task initiate 1 10000000
    ```

    - _Copy the **TxHash**._

2.  **Deposit (Wallet 0)**

    ```bash
    deno task deposit <TxHash> 0 5000000
    ```

3.  **Cancel (Wallet 1)**
    - **Action**: Wallet 1 triggers a cancellation.
    - **On-Chain**: The contract validates the refund logic, ensuring each party gets back exactly what they contributed.
    - **Result**: Wallet 1 gets their original 10 ADA back. Wallet 0 gets their original 5 ADA back.
    ```bash
    deno task cancel <TxHash> 1
    ```

## Command Reference

| Command      | Description              | Usage                                            |
| :----------- | :----------------------- | :----------------------------------------------- |
| `prepare`    | Generate wallets         | `deno task prepare <count>`                      |
| `balances`   | Check wallet balances    | `deno task balances`                             |
| `transfer`   | Send ADA between wallets | `deno task transfer <from> <to> <lovelace>`      |
| `initiate`   | Start a new escrow       | `deno task initiate <wallet> <lovelace>`         |
| `deposit`    | Join an existing escrow  | `deno task deposit <txHash> <wallet> <lovelace>` |
| `complete`   | Finalize and swap assets | `deno task complete <txHash>`                    |
| `cancel`     | Refund assets            | `deno task cancel <txHash> <wallet>`             |
| `list-utxos` | Check status of escrows  | `deno task list-utxos`                           |
