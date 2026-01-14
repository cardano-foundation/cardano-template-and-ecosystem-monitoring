# Atomic Transaction (Offchain - Lucid Evolution)

This project interacts with the Atomic Transaction Aiken smart contract, specifically the minting policy part which requires a password to mint or burn tokens.

## Prerequisites

- [Deno](https://deno.land/) installed.

## Setup

1.  **Install Dependencies**:
    The project uses `deno.json` for dependency management. Deno will automatically download them when running tasks.

2.  **Generate Wallet**:
    Run the prepare command to generate a local wallet file (`wallet_0.txt`).
    ```bash
    deno task prepare 1
    ```
    - This will create a `wallet_0.txt` file containing the seed phrase.
    - **Fund this wallet** using the [Preprod Faucet](https://docs.cardano.org/cardano-testnet/tools/faucet/) before running transactions.

## Usage

### Mint Token

Mints 1 `AtomicToken` by providing the correct redeemer password ("super_secret_password").

```bash
deno task mint
```

### Burn Token

Burns 1 `AtomicToken`.

```bash
deno task burn
```
