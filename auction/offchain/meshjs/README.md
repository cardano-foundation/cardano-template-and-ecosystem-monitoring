# Auction Contract Offchain (MeshJS)

This directory contains the offchain code for interacting with the Auction Aiken contract on Cardano, implemented using MeshJS and Deno.

## Prerequisites

- **Deno**: Install [Deno 1.40+](https://deno.com/).
- **Cardano Node**: Access to Preprod (using Koios provider by default).
- **Wallets**: The app manages local wallets (`wallet_0.txt`, `wallet_1.txt`, etc.).

## Installation

The project uses Deno for dependency management. No manual package installation is required.

## Usage

Use `deno task` for execution.

### 1. Setup Wallets

Generate wallets `wallet_0` (seller) and `wallet_1` (bidder).

```bash
deno task prepare
```

> **Important:** Fund `wallet_0` and `wallet_1` with Testnet ADA (tADA) from the [Cardano Faucet](https://docs.cardano.org/cardano-testnet/tools/faucet) before proceeding.

### 2. Initialize Auction

Start a new auction with a starting bid (default 5 ADA).

```bash
deno task init
```

Note the Transaction Hash (Tx ID) returned.

### 3. Place a Bid

Bid on an active auction. Requires the Tx ID from the initialization step.

```bash
deno task bid <TX_HASH> <AMOUNT_IN_LOVELACE>
```

Example (10 ADA):

```bash
deno task bid 3c4562... 10000000
```

### 4. Close Auction

End the auction and distribute funds/NFT. This can only be called after the expiration period (approximately 16 minutes).

```bash
deno task close <TX_HASH>
```
