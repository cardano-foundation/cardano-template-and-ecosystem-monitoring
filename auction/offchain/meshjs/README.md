# Auction Contract Offchain (MeshJS)

This directory contains the friendly offchain code for interacting with the Auction Aiken on Cardano, powered by MeshJS and Deno. 

## Prerequisites

- **Deno**: Install Deno 1.40+.
- **Cardano Node**: Access to Preprod (using Koios provider by default).
- **Wallets**: The app manages local wallets ('wallet_0.txt', 'wallet_1.txt', etc.).

## Installation

No 'npm install' needed! Deno handles everything.

## Usage

You can use 'deno task' for easy execution.

### 1. Setup Wallets
Generate wallets 'wallet_0' (seller) and 'wallet_1' (bidder).

\\\ash
deno task prepare
\\\\
make sure to fund them with some test ADA! sending like 500 ada to wallet 0 then running 
\\\ash
deno run -A --unstable-detect-cjs fund_wallet_1.ts
\\\\

### 2. Initialize Auction 
Start a new auction with a starting bid (default 5 ADA).

\\\ash
deno task init
\\\\
*Take note of the Transaction Hash (Tx ID) returned!*

### 3. Place a Bid 
Bid on an active auction. You need the Tx ID from the init step.

\\\ash
deno task bid <TX_HASH> <AMOUNT_IN_LOVELACE>
\\\\
Example (10 ADA):
\\\ash
deno task bid 3c4562... 10000000
\\\\

### 4. Close Auction 
End the auction and distribute funds/NFT. Can only be called after expiration (approx 16 mins).

\\\ash
deno task close <TX_HASH>
\\\\

---
*Happy Bidding!* 
