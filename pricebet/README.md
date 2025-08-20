# 📈 Blockchain Price Betting Smart Contract

A decentralized price prediction betting system built on Cardano, allowing participants to bet on future exchange rates between tokens using oracle price feeds.

## 🌟 What is a Blockchain Price Bet?

Traditional price betting requires trusting a centralized platform to:
- Provide accurate and unmanipulated price data
- Hold participant funds securely during the betting period
- Execute payouts fairly based on price outcomes
- Maintain operational stability and solvency
- Prevent insider trading or data manipulation

A blockchain-based price betting system eliminates these trust requirements through **smart contracts** and **decentralized oracles**, creating a transparent and immutable betting mechanism where outcomes are determined by verifiable on-chain price data.

## 💎 Key Benefits

### 🔒 **Trustless Price Discovery**
- Oracle-based price feeds eliminate manipulation risks
- All price data is verifiable on-chain
- No possibility of bet result manipulation by contract owners
- Automatic settlement based on objective price criteria

### 🌐 **Decentralized & Censorship-Resistant**
- No central authority can block, freeze, or confiscate funds
- Operates 24/7 without maintenance windows or geographic restrictions
- Participants interact directly with the blockchain

### 🔍 **Complete Transparency**
- All bet terms and target prices are visible on-chain
- Oracle price sources are verifiable and auditable
- Contract logic is open-source and immutable

### ⚖️ **Fair & Impartial Resolution**
- Winner determined automatically by oracle price feeds
- No human intervention required for settlement
- Time-based deadlines ensure prompt resolution

## 🏗️ Architecture Overview

### Oracle-Based Price Resolution

The price betting system relies on decentralized oracle infrastructure:
- **Price Oracle Contract**: Provides reliable exchange rate data between token pairs
- **Target Rate Mechanism**: Predefined exchange rate that must be reached for player to win
- **Time-Based Settlement**: Automatic resolution after deadline expires
- **Failure Protection**: Owner can reclaim funds if no player joins or wins

## 🔄 Contract Workflow

### Step 1: Bet Initialization
The contract owner sets up:
- Initial pot deposit in native cryptocurrency
- Oracle contract address for price data
- Target exchange rate for winning condition
- Deadline for bet resolution

### Step 2: Player Participation
A player can join by:
- Depositing an amount equal to the initial pot
- Accepting the predefined target exchange rate
- Committing to the bet deadline terms

### Step 3: Price Monitoring
During the active period:
- Oracle continuously provides exchange rate updates
- Player can claim winnings if target rate is exceeded
- Contract monitors price conditions until deadline

### Step 4: Resolution
Two possible outcomes:
- **Player Wins**: If target exchange rate is reached before deadline, player claims entire pot
- **Owner Wins**: If deadline expires without target rate being reached, owner reclaims all funds

## 📋 Contract Specification

### Parameters (defined at deployment):
- **owner**: address that deposits initial pot and can claim timeout
- **oracle**: contract address providing exchange rate data
- **deadline**: time limit for bet resolution
- **target_rate**: exchange rate that must be reached for player to win

### Actions:
- **join**: player deposits matching amount to enter the bet
- **win**: player claims pot if oracle rate exceeds target before deadline
- **timeout**: owner claims pot if deadline expires without player winning

### Required Functionalities:
- Native token handling
- Time constraints implementation
- Contract-to-contract oracle calls
- Transaction revert capabilities
- Exchange rate comparison logic

## 🛠️ Development Approach with Cardano

### Choosing Your Development Stack

For guidance on selecting the right tools and technologies for your Cardano development needs, consult the **[Cardano Tool Compass](https://github.com/cardano-foundation/cardano-tool-compass)** - a comprehensive guide to help you navigate the Cardano development ecosystem and choose the tools that best fit your project requirements and technical preferences.

### Smart Contract Development
Choose your preferred Cardano smart contract language and framework:
- **Aiken**: Functional programming with built-in oracle interaction capabilities
- **Plutus (Haskell)**: Native Cardano smart contract language with strong type safety
- **OpShin (Python)**: Python-based development with oracle integration support
- **Helios**: TypeScript-like syntax for oracle price feed handling

### Oracle Integration
Consider Cardano oracle solutions:
- **Charli3**: Decentralized oracle network for Cardano
- **Orcfax**: Real-world data feeds for Cardano DApps
- **Custom Oracle Contracts**: Build your own price feed mechanism
- **Cross-chain Price Feeds**: Integration with external oracle networks

### Off-chain Development
Select appropriate off-chain tools for price monitoring:
- **JavaScript/TypeScript**: Lucid Evolution, Mesh.js for oracle interaction
- **Java**: Cardano Client Library (CCL) with oracle SDK integration
- **Python**: PyCardano with price feed monitoring capabilities
- **Haskell**: Plutus Application Framework with oracle support

### Development Process
1. **Oracle Selection**: Choose reliable price feed sources for target token pairs
2. **Price Logic Implementation**: Build exchange rate comparison and validation logic
3. **Timing Mechanisms**: Implement proper deadline and timeout handling
4. **Oracle Integration**: Establish secure communication with price feed contracts
5. **Testing**: Thoroughly test with various price scenarios and edge cases

### Cardano-Specific Considerations
- **UTXO Oracle Reading**: Design efficient oracle UTXO consumption patterns
- **Price Data Validation**: Ensure oracle data integrity and freshness
- **Transaction Timing**: Handle slot-based deadlines accurately
- **Oracle Fees**: Account for oracle service costs in bet economics
- **Data Encoding**: Properly encode and decode price feed data

## 🤝 Contributing

This smart contract serves as an educational example of decentralized price betting with oracle integration on Cardano. Contributions, improvements, and discussions are welcome!

## ⚠️ Disclaimer

This is an educational project demonstrating smart contract capabilities on Cardano. Always audit contracts thoroughly before using with real funds. Ensure compliance with local regulations regarding betting, derivatives, and smart contracts. Oracle-based contracts carry additional risks related to price feed accuracy and availability.