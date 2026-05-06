# 🎲 Blockchain Betting Smart Contract

<!-- CI_BADGE_BLOCK_BEGIN -->
[![Ecosystem tests · bet](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml/badge.svg?branch=feat/ecosystem-monitoring-and-learning-enhancement)](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml)
<!-- CI_BADGE_BLOCK_END -->


A decentralized two-player betting system built on Cardano using Aiken, demonstrating the power of trustless wagering with oracle-based resolution.

## 🌟 What is a Blockchain Bet?

Traditional online betting requires trusting a centralized platform to:
- Hold your funds securely
- Execute payouts fairly
- Not manipulate outcomes
- Remain solvent and operational

A blockchain-based bet eliminates these trust requirements through **smart contracts** - a validation layer that automatically enforces the rules without any possibility of manipulation, censorship, or downtime.

## 💎 Key Benefits

### 🔒 **Trustless Execution**
- Funds are locked in the smart contract, not controlled by any party
- Payout logic is transparent and immutable
- No possibility of the "house" running away with your money

### 🌐 **Decentralized & Censorship-Resistant**
- No central authority can block, freeze, or confiscate funds
- Operates 24/7 without maintenance windows or geographic restrictions
- Participants interact directly with the blockchain

### 🔍 **Complete Transparency**
- All bet terms are visible on-chain before participation
- Contract logic is open-source and verifiable
- Transaction history is permanently recorded and auditable

### ⚖️ **Fair & Impartial Resolution**
- Oracle has a strictly limited role: only announcing the winner
- Oracle cannot access funds or change bet terms
- Only the winner is able to receive funds when oracle announces result

## 🏗️ Architecture Overview

### Oracle Design

The oracle in this system has intentionally restricted capabilities:
- ✅ Can announce the winner after bet expiration
- ❌ Cannot access or redirect funds
- ❌ Cannot modify bet terms or participants
- ❌ Cannot act before the bet expiration time

This design ensures the oracle serves purely as a trusted information provider, not a funds custodian.

## 🔄 Contract Workflow

### Step 1: Bet Initialization
The contract verifies:
- Player 1 has signed the transaction
- Initial bet amount is locked in the contract
- Oracle is designated and different from Player 1
- Expiration time is set for the future
- Bet token is minted to track this specific bet

### Step 2: Player 2 Joins
The contract ensures:
- The bet hasn't expired yet
- Player 2 is different from Player 1 and the oracle
- Player 2 matches Player 1's bet amount exactly
- Total pot is now locked in the contract
- Bet datum is updated to include Player 2

### Step 3: Oracle Resolution
After expiration, the contract validates:
- The oracle is authorized to announce results
- The announced winner is one of the two players
- Both players had joined (bet was active)
- Entire pot is sent to the winner's address

### Step 4: Automatic Payout
- No additional action needed from the winner
- No fees beyond standard transaction costs
- Completely non-custodial throughout

## 🚀 Getting Started

### Prerequisites

- [Aiken](https://aiken-lang.org/installation-instructions) - Smart contract development framework
- [Deno](https://deno.land/) - For off-chain code execution
- Cardano wallet with test ADA (for testnet deployment)

### Building the Contract

```bash
# Navigate to the contract directory
cd onchain/aiken

# Validate contract logic
aiken check

# Build the contract
aiken build
```

## 🤝 Contributing

This smart contract serves as an educational example of decentralized betting on Cardano. Contributions, improvements, and discussions are welcome!

## ⚠️ Disclaimer

This is an educational project demonstrating smart contract capabilities on Cardano. Always audit contracts thoroughly before using with real funds. Ensure compliance with local regulations regarding betting and smart contracts.