# Constant Product AMM (Lucid Evolution)

This off-chain client demonstrates how to interact with the constant product AMM smart contract using Lucid Evolution SDK.

## Setup

```sh
cd constant-product-amm/onchain/aiken
aiken build
```

```sh
cd ../../offchain/lucid-evolution
# Fix missing libsodium-sumo.mjs file (workaround for Deno npm compatibility)
./fix-libsodium.sh
deno run -A amm.ts prepare
```

This creates a wallet file (`wallet_user.txt`) that you can fund with test ADA before running AMM operations.

## Usage

The client provides basic functionality for interacting with the AMM:

- `prepare`: Generate wallet files for testing
- `create-pool <reserveA> <reserveB>`: Create a new liquidity pool with initial reserves
- `swap <txHash> <outputIndex> <inputAmount> <minOutput>`: Swap tokens using the pool

### Examples

```sh
# Create initial pool with 1000000 TokenA and 2000000 TokenB
deno run -A amm.ts create-pool 1000000 2000000

# Swap 100000 TokenA for TokenB (minimum 180000 TokenB)
deno run -A amm.ts swap <txHash> 0 100000 180000
```

**Note**: These examples demonstrate the pattern. In production, you would need:
- Actual token minting policies and assets
- LP token minting policy
- Proper token transfers in transactions
- Full error handling and validation

## Requirements

- Deno runtime
- Access to Cardano testnet (Preprod)
- Funded test wallet

## Notes

This is a basic implementation structure. For production use, you would need to implement:
- Token minting for LP tokens
- Swap transaction building with proper slippage protection
- Liquidity addition/removal with proper ratio validation
- Pool state querying and management
