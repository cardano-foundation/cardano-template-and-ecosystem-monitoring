# 🔨 Auction Contract - Aiken Implementation

This directory contains the Aiken implementation of a decentralized English auction smart contract for Cardano.

## 📋 Contract Overview

The auction contract manages the lifecycle of NFT/token auctions through two main components:

- **Minting Policy**: Initializes auctions by locking assets and setting initial parameters
- **Spending Validator**: Handles bidding, withdrawals, and settlement through three actions: `BID`, `WITHDRAW`, `END`

### Core Data Types

```aiken
pub type AuctionDatum {
  seller: VerificationKeyHash,        // Auction creator
  highest_bidder: VerificationKeyHash, // Current winner ("" if none)
  highest_bid: Int,                   // Current bid in lovelace
  expiration: Int,                    // Auction end timestamp
  asset_policy: ByteArray,            // Policy ID of auctioned asset
  asset_name: ByteArray,              // Asset name
}

pub type Action {
  BID,      // Place higher bid
  WITHDRAW, // Reclaim outbid funds (stubbed)
  END,      // Settle auction after expiration
}
```

### Key Validation Logic

**Minting Policy**:

- Seller must sign transaction
- Auctioned asset must be present in script UTXO
- Expiration must be in future
- No initial bidder

**Spending Validator**:

- `BID`: New bid > current bid, bidder signs, asset preserved, before expiration
- `END`: After expiration, exactly 2 outputs (winner gets asset, seller gets ADA)

## 🔧 Aiken Implementation Details

### Key Functions

#### Minting Policy (`mint`)

Validates auction initialization:

- Seller signature verification using `key_signed`
- Asset presence check using `policies` and `list.has`
- Time validation with `valid_before`
- Empty bidder state enforcement

#### Spending Validator (`spend`)

Handles state transitions with pattern matching:

- `BID`: Bid validation, signature checks, asset preservation
- `WITHDRAW`: Currently fails (future implementation)
- `END`: Expiration checks, output validation, asset/ADA transfers

### Aiken Language Features Used

- **Pattern Matching**: `when redeemer is { BID -> {...} }`
- **List Operations**: `list.filter`, `list.has`, `list.length`
- **Option Handling**: `expect Some(value) = ...`
- **Functional Programming**: Higher-order functions with `fn(...)`
- **Type Safety**: Strong typing with custom types and exhaustive matching
- **Error Handling**: `fail` for invalid states, `and { ... }` for multiple conditions

### Testing Approach

Unit tests using Aiken's framework with mocktail utilities:

- Auction initialization
- Bid validation and state updates
- Settlement logic and asset transfers

## � Setup & Development Guide

### Prerequisites

- [Aiken](https://aiken-lang.org/installation-instructions) installed
- Basic familiarity with functional programming concepts

### Project Structure

```
auction/onchain/aiken/
├── aiken.toml          # Project configuration and dependencies
├── validators/
│   └── auction.ak      # Main contract implementation
├── lib/                # Shared libraries (currently empty)
├── build/              # Compiled Plutus Core artifacts
└── README.md           # This documentation
```

### Key Dependencies

- **aiken-lang/stdlib**: Core standard library
- **cocktail/vodka_extra_signatories**: Signature validation (`key_signed`)
- **cocktail/vodka_validity_range**: Time validation (`valid_before`, `valid_after`)
- **mocktail/\***: Testing utilities for mock data

### Development Workflow

1. **Navigate to directory**: `cd auction/onchain/aiken`
2. **Check code**: `aiken check` - Verify types and compilation
3. **Run tests**: `aiken test` - Execute unit tests
4. **Build contract**: `aiken build` - Generate Plutus Core
5. **View docs**: `aiken docs` - Generate documentation

### Available Commands

```bash
# Type checking and compilation validation
aiken check

# Run comprehensive test suite
aiken test

# Build to Plutus Core for deployment
aiken build

# Generate HTML documentation
aiken docs

# Show available commands
aiken --help
```

### Testing

The contract includes unit tests covering core functionality:

- **Auction Initialization**: Validates minting policy and initial state
- **Bidding Logic**: Tests bid validation, state updates, and signature checks
- **Settlement Process**: Verifies asset transfers and ADA distribution

Tests use mock data from `mocktail` packages to simulate real Cardano transactions.

### Building for Production

```bash
aiken build
```

This generates optimized Plutus Core bytecode in the `build/` directory, ready for deployment to Cardano mainnet or testnets.

## 🤝 Contributing

This Aiken implementation demonstrates functional smart contract development. Areas for improvement:

- **WITHDRAW Action**: Implement proper bid withdrawal mechanism
- **Batch Bidding**: Support for multiple concurrent bids
- **Extended Auctions**: Automatic extension on last-minute bids
- **Additional Tests**: Property-based testing for edge cases

### Guidelines

- Follow functional programming principles
- Use exhaustive pattern matching
- Include comprehensive test coverage
- Maintain type safety throughout

## ⚠️ Disclaimer

Educational project demonstrating Aiken development on Cardano. Always audit contracts thoroughly before mainnet deployment.
