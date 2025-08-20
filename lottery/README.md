# 🎲 Blockchain Lottery Smart Contract

A decentralized two-player lottery system built on Cardano, implementing a fair commit-reveal-punish protocol to ensure trustless randomness without external oracles.

## 🌟 What is a Blockchain Lottery?

Traditional lotteries require trusting a centralized operator to:
- Generate random numbers fairly
- Hold participant funds securely
- Execute payouts correctly
- Prevent manipulation of results
- Remain operational and solvent

A blockchain-based lottery eliminates these trust requirements through **smart contracts** that implement cryptographic protocols for fair randomness generation, ensuring no party can manipulate the outcome or access funds unfairly.

## 💎 Key Benefits

### 🔒 **Trustless Randomness**
- No external random number oracles required
- Commit-reveal protocol ensures fair outcome generation
- Neither player can predict or manipulate the result
- Cryptographic proofs guarantee fairness

### 🌐 **Decentralized & Censorship-Resistant**
- No central authority can block, freeze, or confiscate funds
- Operates 24/7 without maintenance windows or geographic restrictions
- Participants interact directly with the blockchain

### 🔍 **Complete Transparency**
- All lottery terms are visible on-chain before participation
- Randomness generation process is fully verifiable
- Transaction history is permanently recorded and auditable

### ⚖️ **Fair & Impartial Resolution**
- Winner is determined by cryptographic function of both players' secrets
- Dishonest behavior is automatically punished
- Honest players are protected against malicious participants

## 🏗️ Architecture Overview

### Commit-Reveal-Punish Protocol

The lottery uses a sophisticated multi-phase protocol:
- **Commit Phase**: Players submit hash commitments of their secret values
- **Reveal Phase**: Players reveal their actual secret values
- **Punishment Mechanism**: Dishonest or non-participating players lose their bets
- **Fair Resolution**: Winner determined by cryptographic combination of secrets

## 🔄 Contract Workflow

### Step 1: Commitment Phase
Both players commit by:
- Depositing equal bet amounts
- Submitting hash of their secret value (commitment)
- Setting deadline for completion (`end_commit`)

### Step 2: First Reveal
Player 1 reveals their secret:
- Must reveal before `end_reveal` deadline
- Revealed value must match original hash commitment
- If Player 1 fails to reveal, Player 2 can claim all funds

### Step 3: Second Reveal
Player 2 reveals their secret:
- Must reveal after Player 1 and before extended deadline
- Revealed value must match original hash commitment
- If Player 2 fails to reveal, Player 1 can claim all funds

### Step 4: Winner Determination
After both reveals:
- Winner determined by fair function of both revealed secrets
- Typically uses XOR or similar bitwise operation
- Winner automatically receives the entire pot
- Process is completely deterministic and verifiable

## 📋 Contract Specification

### Parameters (defined at deployment):
- **bet_amount**: equal amount both players must deposit
- **end_commit**: deadline for both players to join and commit
- **end_reveal**: deadline for reveal phase completion

### Actions:
- **join**: players deposit bet and submit secret commitment
- **reveal**: players reveal their secret values in order
- **claim_timeout**: claim funds if opponent fails to participate
- **claim_win**: winner claims the pot after fair determination

### Required Functionalities:
- Native token handling
- Hash functions for commitment scheme
- Time constraints implementation
- Bitwise operations for winner determination
- Transaction revert capabilities

## 🛠️ Development Approach with Cardano

### Choosing Your Development Stack

For guidance on selecting the right tools and technologies for your Cardano development needs, consult the **[Cardano Tool Compass](https://github.com/cardano-foundation/cardano-tool-compass)** - a comprehensive guide to help you navigate the Cardano development ecosystem and choose the tools that best fit your project requirements and technical preferences.

### Smart Contract Development
Choose your preferred Cardano smart contract language and framework:
- **Aiken**: Functional programming with built-in cryptographic functions
- **Plutus (Haskell)**: Native Cardano smart contract language with strong type safety
- **OpShin (Python)**: Python-based development with hash function support
- **Helios**: TypeScript-like syntax with cryptographic primitives

### Off-chain Development
Select appropriate off-chain tools for commitment and reveal logic:
- **JavaScript/TypeScript**: Lucid Evolution, Mesh.js, or CardanoJS
- **Java**: Cardano Client Library (CCL)
- **Python**: PyCardano with cryptographic libraries
- **Haskell**: Plutus Application Framework

### Development Process
1. **Protocol Design**: Implement commit-reveal scheme with proper timeout handling
2. **Cryptographic Implementation**: Ensure secure hash functions and randomness generation
3. **Testing**: Thoroughly test all scenarios including dishonest behavior
4. **Security Audit**: Verify punishment mechanisms and fairness guarantees
5. **Deployment**: Deploy to Cardano mainnet after comprehensive testing

### Cardano-Specific Considerations
- **Hash Functions**: Utilize Cardano's built-in cryptographic primitives
- **Time Handling**: Implement proper slot-based timeout mechanisms
- **UTXO Design**: Structure commitments and reveals in separate UTXOs
- **Randomness Security**: Ensure secrets have sufficient entropy
- **Gas Optimization**: Minimize transaction costs for all participants

## 🤝 Contributing

This smart contract serves as an educational example of decentralized lottery systems with fair randomness on Cardano. Contributions, improvements, and discussions are welcome!

## ⚠️ Disclaimer

This is an educational project demonstrating smart contract capabilities on Cardano. Always audit contracts thoroughly before using with real funds. Ensure compliance with local regulations regarding gambling and smart contracts.