# 💱 Constant Product AMM Smart Contract

A decentralized automated market maker built on Cardano, implementing the constant product formula (x * y = k) to enable trustless token swaps and liquidity provision.

## 🌟 What is a Constant Product AMM?

Traditional cryptocurrency exchanges require order books and market makers to facilitate trading, creating several limitations:
- Centralized control over trading pairs and liquidity
- Dependence on active market makers for price discovery
- High barriers to entry for providing liquidity
- Potential for front-running and price manipulation
- Limited trading pairs and geographic restrictions

A constant product automated market maker (AMM) enables **decentralized trading** where users can swap tokens against liquidity pools following the mathematical formula x * y = k, ensuring continuous liquidity and fair price discovery without traditional market makers.

## 💎 Key Benefits

### 🔄 **Automated Market Making**
- Algorithmic price discovery based on supply and demand
- Continuous liquidity availability for supported token pairs
- No need for traditional order books or centralized market makers
- Automatic arbitrage opportunities maintain price equilibrium

### 🌐 **Permissionless Liquidity**
- Anyone can provide liquidity and earn trading fees
- No minimum requirements or approval processes
- Proportional share of trading fees based on liquidity contribution
- Instant liquidity withdrawal capabilities

### 🔍 **Transparent Pricing**
- All pricing calculations are deterministic and verifiable
- Complete transparency of trading mechanics
- Real-time price impact calculations
- Historical trading data permanently recorded

### ⚖️ **Decentralized & Trustless**
- No central authority controls the trading process
- Smart contracts automatically execute trades and distribute fees
- Immutable trading rules ensure fair treatment for all participants
- Censorship-resistant trading infrastructure

## 🏗️ Architecture Overview

### Constant Product Formula Design

The AMM contract implements the proven constant product mechanism:
- ✅ Maintains constant product (x * y = k) for price calculation
- ✅ Automatic slippage calculation based on trade size
- ✅ Proportional fee distribution to liquidity providers
- ✅ Protection against infinite loss and sandwich attacks
- ❌ No price manipulation or unfair trading advantages

This design ensures that trading remains fair and sustainable while providing continuous liquidity for token pairs.

## 🔄 Contract Workflow

### Step 1: Liquidity Pool Creation
The contract enables:
- Creation of new trading pairs between two tokens
- Initial liquidity provision sets the starting exchange rate
- Minting of liquidity tokens representing pool ownership share
- Establishment of trading fee structure

### Step 2: Liquidity Provision
For adding liquidity:
- Users deposit equal value amounts of both tokens
- Pool calculates optimal ratio based on current reserves
- Liquidity tokens are minted proportional to contribution
- Immediate participation in trading fee collection

### Step 3: Token Swapping
During trading:
- Users specify input token, amount, and minimum output
- AMM calculates output using constant product formula
- Trading fees are deducted and added to pool reserves
- Price impact is determined by trade size relative to liquidity

### Step 4: Liquidity Removal
For withdrawing liquidity:
- Users burn their liquidity tokens to reclaim underlying assets
- Proportional share of both tokens returned to liquidity provider
- Includes accumulated trading fees from all transactions
- Pool reserves are updated to reflect withdrawal

## 📋 Contract Specification

### Parameters (defined at deployment):
- **token_a**: first token in the trading pair
- **token_b**: second token in the trading pair
- **trading_fee**: percentage fee charged on each swap (typically 0.3%)

### Actions:
- **create_pool**: establish new liquidity pool for token pair
- **add_liquidity**: deposit tokens to pool and receive liquidity tokens
- **swap_tokens**: exchange one token for another using constant product formula
- **remove_liquidity**: burn liquidity tokens and withdraw proportional reserves
- **collect_fees**: claim accumulated trading fees (for liquidity providers)

### Required Functionalities:
- Native token handling and transfers
- Arbitrary precision arithmetic for price calculations
- Slippage protection and minimum output guarantees
- Liquidity token minting and burning
- Fee collection and distribution mechanisms

## 🛠️ Development Approach with Cardano

### Choosing Your Development Stack

For guidance on selecting the right tools and technologies for your Cardano development needs, consult the **[Cardano Tool Compass](https://github.com/cardano-foundation/cardano-tool-compass)** - a comprehensive guide to help you navigate the Cardano development ecosystem and choose the tools that best fit your project requirements and technical preferences.

### Smart Contract Development
Choose your preferred Cardano smart contract language and framework:
- **Aiken**: Functional programming approach with precise arithmetic for AMM calculations
- **Plutus (Haskell)**: Native Cardano smart contract language with advanced mathematical operations
- **OpShin (Python)**: Python-based smart contract development with DeFi libraries
- **Helios**: TypeScript-like syntax for Cardano contracts with AMM support

### Off-chain Development
Select appropriate off-chain tools based on your tech stack:
- **JavaScript/TypeScript**: Lucid Evolution for DEX interactions, Mesh.js for AMM management
- **Java**: Cardano Client Library (CCL) with DeFi protocol support
- **Python**: PyCardano with AMM calculation libraries
- **Haskell**: Plutus Application Framework with native DeFi capabilities

### Development Process
1. **Design Phase**: Define AMM mechanics, fee structures, and liquidity management
2. **Implementation**: Build smart contracts with precise mathematical operations
3. **Testing**: Thoroughly test trading scenarios and edge cases on testnets
4. **Integration**: Develop off-chain components for user interface and arbitrage
5. **Deployment**: Deploy to Cardano mainnet after comprehensive financial testing

### Cardano-Specific Considerations
- **Native Tokens**: Leverage Cardano's native token capabilities for all trading pairs
- **UTXO Model**: Design efficient AMM operations using UTXO parallelization
- **Precision Arithmetic**: Handle token decimals and price calculations accurately
- **MEV Protection**: Implement safeguards against maximal extractable value attacks
- **Batching**: Enable efficient batch swaps and liquidity operations

## 🤝 Contributing

This smart contract serves as an educational example of automated market making on Cardano. Contributions, improvements, and discussions are welcome!

## ⚠️ Disclaimer

This is an educational project demonstrating AMM capabilities on Cardano. Always audit contracts thoroughly before providing liquidity or trading significant amounts. Understand the risks of impermanent loss and slippage before participating in AMM protocols. Ensure compliance with local regulations regarding decentralized trading.