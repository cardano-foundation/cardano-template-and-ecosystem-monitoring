# 🔨 Auction Smart Contract - Aiken Implementation

A decentralized English auction system implemented in **Aiken** for Cardano, demonstrating functional programming principles and strong type safety in smart contract development.

## 🌟 What is a Blockchain Auction?

Traditional online auctions require trusting a centralized platform to:

- Hold bids securely during the auction period
- Execute fair bidding processes
- Handle winner determination correctly
- Manage refunds for outbid participants
- Prevent bid manipulation or shill bidding

A blockchain-based auction eliminates these trust requirements through **smart contracts** - creating a transparent, immutable auction mechanism where all rules are enforced automatically without any possibility of manipulation or censorship.

## 💎 Key Benefits

### 🔒 **Trustless Execution**

- All bids are locked in the smart contract, not controlled by any party
- Auction logic is transparent and immutable
- No possibility of bid manipulation or unfair practices

### 🌐 **Decentralized & Censorship-Resistant**

- No central authority can block, freeze, or confiscate bids
- Operates 24/7 without maintenance windows or geographic restrictions
- Participants interact directly with the blockchain

### 🔍 **Complete Transparency**

- All auction terms and current bids are visible on-chain
- Contract logic is open-source and verifiable
- Bidding history is permanently recorded and auditable

### ⚖️ **Fair & Impartial Resolution**

- Highest bidder automatically wins when auction expires
- Automatic refunds for outbid participants
- No human intervention required for settlement

## 🏗️ Architecture Overview

### Auction Design

The auction contract implements a standard English auction with these mechanics:

- ✅ **Single Asset Auction**: One NFT or token auctioned at a time
- ✅ **Escrow Model**: Asset locked in script UTXO alongside accumulated bids
- ✅ **Open Bidding**: Anyone can bid by exceeding current highest bid
- ✅ **Time-Bound**: Strict expiration prevents indefinite auctions
- ✅ **Atomic Settlement**: Winner receives asset, seller receives ADA in single transaction
- ❌ **No Reserve Price**: Starting bid can be 0, no hidden minimums
- ❌ **No Bid Withdrawal**: Once bid, funds locked until auction ends (withdrawals planned)

### Smart Contract Structure

**Minting Policy** (`mint` function):

- Creates auction token and locks asset
- Validates seller signature and initial parameters

**Spending Validator** (`spend` function):

- Handles three actions: BID, WITHDRAW, END
- Enforces auction rules and state transitions
- Manages asset and ADA transfers

## 🔄 Contract Workflow

### Step 1: Auction Creation (Minting Policy)

The minting policy initializes a new auction by:

- **Seller Verification**: Seller must sign the transaction
- **Asset Locking**: The auctioned asset (NFT/token) is locked in the script UTXO
- **Initial State**: No highest bidder yet, starting bid set (can be 0 or positive)
- **Time Validation**: Auction expiration must be in the future
- **Token Minting**: Mints a unique auction token to identify this auction instance

### Step 2: Bidding Phase (BID Action)

During active auction period:

- **Bid Validation**: New bid must strictly exceed current highest bid
- **Signer Verification**: New highest bidder must sign the transaction
- **Asset Preservation**: Auctioned asset remains locked in the script UTXO
- **State Update**: Datum updates with new highest bidder and bid amount
- **ADA Accumulation**: Additional ADA is added to the script UTXO
- **Time Check**: Bidding only allowed before auction expiration

### Step 3: Withdrawal Process (WITHDRAW Action)

Currently stubbed for future implementation:

- Designed to allow outbid participants to reclaim their funds
- Will require tracking individual bid amounts per bidder
- Prevents arbitrary withdrawals on the main auction UTXO

### Step 4: Auction Settlement (END Action)

After auction expiration:

- **Expiration Check**: Transaction must occur after auction deadline
- **Final Outputs**: Exactly two outputs created - one for winner, one for seller
- **Asset Transfer**: Auctioned item goes to the highest bidder's address
- **ADA Transfer**: Accumulated bid amount goes to seller's address
- **No Continuation**: Auction UTXO is consumed with no continuing script output
- **Bid Requirement**: Auction must have received at least one bid to settle

## 📋 Contract Specification

### Parameters (defined at deployment):

- **seller**: Public key hash of the auction creator
- **highest_bidder**: Current highest bidder (empty string if none)
- **highest_bid**: Current highest bid amount in lovelace
- **expiration**: Auction expiration timestamp
- **asset_policy**: Policy ID of the auctioned asset
- **asset_name**: Asset name of the auctioned asset

### Actions:

- **MINT**: Initializes auction (via minting policy)
- **BID**: Submit higher bid during auction period
- **WITHDRAW**: Reclaim funds when outbid (future implementation)
- **END**: Settle auction after expiration

### Validation Rules:

- **Minting**: Seller signs, asset locked, expiration in future
- **Bidding**: Bid > current highest, bidder signs, asset preserved, before expiration
- **Ending**: After expiration, exactly 2 outputs (winner gets asset, seller gets ADA)

## 🔧 Aiken Implementation Details

### Core Types

```aiken
pub type AuctionDatum {
  seller: VerificationKeyHash,
  highest_bidder: VerificationKeyHash,
  highest_bid: Int,
  expiration: Int,
  asset_policy: ByteArray,
  asset_name: ByteArray,
}

pub type Action {
  BID
  WITHDRAW
  END
}
```

### Key Functions

#### Minting Policy (`mint`)

- **Purpose**: Initialize auction with asset locking
- **Validation**:
  - Seller signature verification using `key_signed`
  - Asset presence check using `policies` and `list.has`
  - Time validation with `valid_before`
  - Empty bidder state enforcement

#### Spending Validator (`spend`)

- **Purpose**: Handle auction state transitions
- **BID Action**:
  - Bid amount validation (`new_bid > highest_bid`)
  - Bidder signature with `key_signed`
  - Asset preservation checks
  - ADA accumulation verification
- **END Action**:
  - Expiration check with `valid_after`
  - Output structure validation (exactly 2 outputs)
  - Asset transfer to winner
  - ADA transfer to seller

### Aiken Language Features Used

- **Pattern Matching**: `when redeemer is { BID -> {...} }`
- **List Operations**: `list.filter`, `list.has`, `list.length`
- **Option Handling**: `expect Some(value) = ...`
- **Functional Programming**: Higher-order functions with `fn(...)`
- **Type Safety**: Strong typing with custom types and exhaustive matching
- **Error Handling**: `fail` for invalid states, `and { ... }` for multiple conditions

### Testing Approach

The contract includes comprehensive unit tests using Aiken's testing framework:

- **Initialization Test**: Verifies auction setup with proper parameters
- **Bidding Test**: Validates bid submission and state updates
- **Settlement Test**: Confirms proper asset and ADA distribution

Tests use mock utilities from `mocktail` for realistic test data generation.

## 🛠️ Aiken Development Approach

### Why Aiken?

Aiken brings functional programming principles to Cardano smart contracts:

- **Strong Type Safety**: Compile-time guarantees prevent runtime errors
- **Functional Paradigm**: Immutable data and pure functions
- **Expressive Syntax**: Clean, readable code with powerful pattern matching
- **Built-in Testing**: Integrated test framework with property-based testing
- **Cardano Native**: Direct compilation to Plutus Core

### Project Structure

```
auction/onchain/aiken/
├── aiken.toml          # Project configuration
├── validators/
│   └── auction.ak      # Main contract implementation
├── lib/                # Shared libraries (if any)
├── build/              # Compiled artifacts
└── README.md           # This documentation
```

### Key Dependencies

- **aiken-lang/stdlib**: Core Aiken standard library
- **cocktail/vodka_extra_signatories**: Signature validation utilities
- **cocktail/vodka_validity_range**: Time-based validation functions
- **mocktail/\***: Testing utilities for mock data generation

### Development Workflow

1. **Design**: Define types and validation logic
2. **Implement**: Write pure functions with exhaustive pattern matching
3. **Test**: Use Aiken's test framework with mock data
4. **Build**: Compile to Plutus Core with `aiken build`
5. **Verify**: Check with `aiken check` for type safety

## 🚀 Running the Project

### Prerequisites

- [Aiken](https://aiken-lang.org/installation-instructions) installed
- Basic familiarity with functional programming concepts

### Commands

```bash
# Check for compilation errors and type safety
aiken check

# Run the test suite
aiken test

# Build the contract to Plutus Core
aiken build

# Generate documentation
aiken docs
```

### Testing

The contract includes unit tests covering:

- Auction initialization
- Bid validation and state updates
- Settlement logic and asset transfers

Run tests with `aiken test` to ensure all validations work correctly.
