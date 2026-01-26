# Simple Transfer (Lucid Evolution)

This project demonstrates a simple transfer contract where funds are locked for a specific receiver using a parameterized Aiken validator.

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
   deno task prepare 2
   ```
   This generates `wallet_0.txt` and `wallet_1.txt`. You should fund these addresses on Preprod.

## Usage

### Lock Funds
Lock 5 ADA for the address in `wallet_1.txt` (using wallet 0 to lock):
```bash
deno task lock 5000000 <ADDRESS_OF_WALLET_1> 0
```

### Claim Funds
Claim funds as the receiver (using `wallet_1.txt`):
```bash
deno task claim 1
```

## Utilities

### Check Balance
Check the balance of a wallet (e.g., wallet 0):
```bash
deno task balance 0
```

### Transfer ADA
Transfer ADA between wallets (e.g., transfer 10 ADA from wallet 0 to wallet 1):
```bash
deno task transfer 10000000 <ADDRESS_OF_WALLET_1> 0
```
