# HTLC Off-chain (MeshJS)

This folder contains the off-chain implementation of the Hash Time Locked Contract (HTLC) using the MeshJS SDK.

## Prerequisites

- [Deno](https://deno.land/) installed.
- A Cardano wallet with some test ADA on the Preprod network.

## Setup

1.  **Prepare Wallets**: Generate seed phrases for testing.

    ```bash
    deno task prepare
    ```

    This will create `wallet_0.txt`, `wallet_1.txt`, etc.

2.  **Fund Wallets**: Send some tADA to the addresses generated.

    ```bash
    deno task show-addresses
    ```

    Fund at least `wallet_0` (for locking/refunding) and `wallet_1` (for claiming).

3.  **Check Balances**:

    ```bash
    deno task balances
    ```

4.  **Transfer Funds**: If you need to transfer funds between wallets (e.g., for collateral):
    ```bash
    deno task transfer
    ```
    Or manually:
    ```bash
    deno run -A htlc.ts transfer 0 1 10000000
    ```

## Usage

### 1. Initialize HTLC (Lock Funds)

Lock 10 ADA with a secret "mySecret" using `wallet_0`.

```bash
deno run -A htlc.ts init 10000000 mySecret 0 3600
```

- `10000000`: Amount in lovelace.
- `mySecret`: The secret preimage.
- `0`: Wallet index to use (owner).
- `3600`: Expiration time in seconds.

### 2. Claim HTLC

Claim the locked funds using the secret preimage and `wallet_1`.

```bash
deno run -A htlc.ts claim <txHash> mySecret 1
```

- `<txHash>`: The transaction ID from the `init` step.
- `mySecret`: The secret preimage.
- `1`: Wallet index to use (claimer).

### 3. Refund HTLC

Refund the locked funds after expiration using `wallet_0`.

```bash
deno run -A htlc.ts refund <txHash> 0
```

- `<txHash>`: The transaction ID from the `init` step.
- `0`: Wallet index to use (owner).

## Scripts

- `htlc.ts`: Main CLI for HTLC operations.
  - `init`: Lock funds.
  - `claim`: Claim funds.
  - `refund`: Refund funds.
  - `prepare`: Generate test wallets.
  - `show-addresses`: Show wallet addresses.
  - `balances`: Check wallet balances.
  - `list-utxos`: List active HTLC UTXOs.
  - `transfer`: Transfer funds between wallets.
- `lib/utils.ts`: Shared library for wallet management, store, and crypto.
