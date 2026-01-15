# Price Bet (Lucid Evolution)

This project demonstrates a decentralized price prediction betting system using Aiken on-chain validators and the Lucid Evolution off-chain library with Charli3 oracles.

## Prerequisites

- [Deno](https://deno.land/)
- [Aiken](https://aiken-lang.org/) (for building the contract)

## Setup

1. Build the Aiken contract:
   ```bash
   cd ../../onchain/aiken
   aiken build
   ```

2. Prepare wallets:
   ```bash
   deno task prepare 4
   ```
   This generates `wallet_0.txt` to `wallet_3.txt`. You should fund these addresses on Preprod.

## Usage

### Create a Bet
Owner (wallet 0) creates a bet with a target price, deadline, and bet amount (in ADA):
```bash
deno task create <TARGET_PRICE> <DEADLINE_IN_MS> <BET_AMOUNT_ADA> 0
```
Example: `deno task create 1500 3600000 10 0` (Target 15.00, 1 hour deadline, 10 ADA bet).

### Join a Bet
Player (wallet 1) matches the bet using the transaction hash and output index of the creation:
```bash
deno task join <TX_HASH> <INDEX> 1
```

### Win a Bet
Player (wallet 1) wins the bet if the target price is hit by referencing the oracle UTXO:
```bash
deno task win <BET_TX_HASH> <INDEX> <ORACLE_TX_HASH> <ORACLE_INDEX> 1
```

### Timeout a Bet
Owner (wallet 0) reclaims the total pot if the deadline has passed:
```bash
deno task timeout <BET_TX_HASH> <INDEX> 0
```

## Utilities

### Check Balance
Check the balance of a wallet (e.g., wallet 0):
```bash
deno task balance 0
```
