# Upgradable Proxy Smart Contract

A two-contract system implementing upgradable logic through proxy delegation using Cardano's atomic transactions. The proxy contract has a datum with a script hash and validates that spending transactions based on that script hash are part of the transaction and mints a token as proof of execution.

## 🌟 What is this Upgradable Proxy Pattern?

Traditional smart contracts are immutable once deployed, creating limitations for contract evolution:
- Logic bugs cannot be fixed without complete redeployment
- Feature updates require new contract addresses
- User interactions must migrate to new contract instances
- No mechanism for seamless contract improvements
- State migration between contracts is complex and risky

This upgradable proxy pattern provides **delegated execution** where a proxy contract stores an implementation script hash in its datum and validates that the implementation contract executes in the same transaction. To upgrade the "contract", the datum needs to be updated with the new script hash. Due to atomic transactions in Cardano, the spending validation of the referenced contract must succeed to make the proxy contract work and mint the delegation token.

## 💎 Key Benefits

### 🔄 **Logic Upgradability**
- Implementation contract can be updated by changing the script hash in proxy datum
- Bug fixes and feature improvements without changing proxy address
- Seamless upgrades maintain existing user interactions
- Preserved contract state across logic updates

### 🌐 **Atomic Validation**
- Proxy validates that implementation contract executes in the same transaction
- Uses Cardano's atomic transactions to ensure both contracts succeed together
- Mints delegation token as cryptographic proof of successful execution
- Changing logic dynamically ensures upgradability without changing proxy script hash

### 🔍 **Delegated Execution**
- Proxy forwards calls to current implementation based on script hash in datum
- Implementation contract provides actual business logic
- Token minting serves as proof of successful delegation
- Transparent execution model for users

### ⚖️ **Controlled Updates**
- Implementation address can be updated through proxy datum modification
- Upgrade mechanisms built into proxy contract with owner validation
- Atomic upgrade process ensures consistency
- Flexible deployment and interaction patterns

## 🏗️ Architecture Overview

### Two-Contract Design

The upgradable proxy system implements delegation through two essential contracts:
- ✅ **Proxy Contract** - stores implementation script hash in datum and validates atomic execution
- ✅ **Logic Contract** - contains the actual business logic implementation that can be upgraded
- ✅ Atomic transaction validation ensuring both proxy and implementation execute together
- ✅ Token minting as cryptographic proof of successful delegation
- ❌ No caller contract needed - users interact directly with the proxy

This design ensures that logic can be upgraded by updating the script hash in the proxy datum while maintaining the same proxy contract address. Any user wallet or dApp can interact directly with the proxy contract.

## 📋 Contract Specification

### Proxy Contract:
- **Implementation Reference**: datum contains script hash pointing to current logic implementation
- **Delegation Validation**: validates that implementation contract executes in same transaction
- **Token Minting**: mints proof token when delegation succeeds
- **Upgrade Mechanism**: owner can update implementation script hash in datum

### Logic Contract:
- **Business Logic**: contains the actual functionality that can be upgraded
- **State Management**: handles counter and data operations
- **Implementation**: provides core functionality executed through proxy

There are 2 contracts in this upgradable proxy system:

- proxy contract - stores implementation script hash and validates atomic execution
- logic contract - contains business functionality that can be upgraded

**User Interaction**: Regular wallets and dApps can interact directly with the proxy contract without needing an intermediary caller contract.

## 🛠️ Development Approach with Cardano

### Choosing Your Development Stack

For guidance on selecting the right tools and technologies for your Cardano development needs, consult the **[Cardano Tool Compass](https://github.com/cardano-foundation/cardano-tool-compass)** - a comprehensive guide to help you navigate the Cardano development ecosystem and choose the tools that best fit your project requirements and technical preferences.

### Smart Contract Development
Choose your preferred Cardano smart contract language and framework:
- **Aiken**: Functional programming approach with strong version management
- **Plutus (Haskell)**: Native Cardano smart contract language with registry patterns
- **OpShin (Python)**: Python-based smart contract development with version control
- **Helios**: TypeScript-like syntax for Cardano contracts with evolution support

### Off-chain Development
Select appropriate off-chain tools based on your tech stack:
- **JavaScript/TypeScript**: Lucid Evolution for registry management, Mesh.js for version interactions
- **Java**: Cardano Client Library (CCL) with version governance support
- **Python**: PyCardano with registry patterns and migration capabilities
- **Haskell**: Plutus Application Framework with native version management

### Development Process
1. **Design Phase**: Define registry architecture, version governance, and migration procedures
2. **Implementation**: Build registry and versioned contracts with evolution safety
3. **Testing**: Thoroughly test version scenarios and migration paths on testnets
4. **Integration**: Develop off-chain components for version management and user migration
5. **Deployment**: Deploy to Cardano mainnet after comprehensive version testing

### Cardano-Specific Considerations
- **UTXO Model**: Design version patterns compatible with Cardano's UTXO architecture
- **Script References**: Utilize script references for efficient version validation
- **Registry Management**: Implement governance for version approval and deprecation
- **State Migration**: Handle user data migration efficiently within UTXO constraints
- **Version Atomicity**: Ensure atomic version updates using Cardano's transaction model

## 🤝 Contributing

This smart contract serves as an educational example of contract evolution patterns on Cardano. Contributions, improvements, and discussions are welcome!

## ⚠️ Disclaimer

This is an educational project demonstrating contract evolution capabilities on Cardano. Since Cardano validators are immutable, this pattern provides version management rather than true upgradability. Always audit version management mechanisms thoroughly before using in production. Ensure proper governance and security reviews for all contract versions. Consider the limitations of version-based evolution carefully.