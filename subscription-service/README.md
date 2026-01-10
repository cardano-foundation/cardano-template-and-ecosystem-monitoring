# 🔨 Blockchain Subscription Service Smart Contract

A decentralized subscription system built on Cardano, enabling trustless recurring payments for tiered access to digital services, content, or premium features with automated renewals and refunds.

## 🌟 What is a Blockchain Subscription Service?

Traditional subscription platforms depend on centralized infrastructure to:

- Track billing cycles and payment status
- Enforce tiered access control rules
- Process failed payments and cancellations
- Prevent unauthorized service access
- Handle refunds and account management

A blockchain subscription service replaces this with **smart contracts** that automatically enforce payment schedules, access rules, and refunds - eliminating intermediaries while providing full transparency and automation.

## 💎 Key Benefits

### 🔒 **Trustless Payment Automation**

- Funds locked directly in smart contract UTxOs
- Automatic renewal validation by time and amount
- No platform can freeze, censor, or manipulate payments
- Immutable record of all subscription activity

### 🌐 **Decentralized & Always-On**

- Operates 24/7 across all Cardano wallets
- No server downtime or geographic restrictions
- Multi-dApp compatibility via standard UTxO queries
- Automatic lifecycle management (renew/cancel/refund)

### 🔍 **Full On-Chain Transparency**

- Current subscription status visible via any explorer
- Payment history permanently auditable
- No hidden fees or surprise billing
- Service providers verify access instantly

### ⚖️ **Automated Lifecycle Management**

- Grace periods prevent service disruption
- Self-executing refunds after expiration
- Tier upgrades/downgrades via payment adjustment
- No manual intervention required

## 🏗️ Architecture Overview

### Core Subscription Design

Clear, deterministic mechanics suitable for both on-chain validators and off-chain applications:

- ✅ Users lock payment with tier selection and period definition
- ✅ System validates renewals against minimum payment + time elapsed
- ✅ Grace period prevents immediate service interruption
- ✅ Auto-refund after grace period expiration
- ✅ Service providers query UTxO state for access decisions

## 🔄 Complete Workflow

### Step 1: Subscription Creation

System verifies and records:

- Sufficient initial payment for selected tier
- Subscription period length (30/90/365 days)
- Subscriber wallet address for renewal authorization
- Service description and terms notarized on-chain

### Step 2: Active Subscription Period

During valid subscription:

- Users can renew before period expires (with grace window)
- Payment must meet/exceed tier minimum
- System updates expiration timestamp
- Service access granted via UTxO validation

### Step 3: Grace Period Management

Automatic handling prevents abuse:

- 7-day grace period for late renewals
- Service continues during grace window
- Underpayment triggers refund countdown
- Clean state reset after final expiration

### Step 4: Access Control Integration

Service providers implement simple queries:

- Check user's subscription UTxO exists at script address
- Validate current time < subscription expiration
- Verify tier meets minimum service requirements
- Optional NFT minting for premium feature gating

## 📋 System Specification

### Subscription State Data:

```
subscriber_address: Wallet pubkey hash
current_tier: Basic | Pro | Enterprise
minimum_payment: ADA amount per period
period_start_timestamp: Creation time
period_length_seconds: 30/90/365 days
grace_period_seconds: 7 days
service_identifier: Optional service hash
```

### Core Operations:

- **Create**: Initialize new subscription with payment
- **Renew**: Extend period with valid payment
- **Cancel**: Refund remaining balance to subscriber
- **Upgrade**: Switch to higher tier with payment adjustment
- **Query**: Check active status for access control

### Validation Rules:

- Payments must meet tier minimums
- Renewals require period expiration + grace window
- Only subscriber can renew/cancel own subscription
- Grace period prevents premature fund locking
- Anti-replay protection via UTxO reference

## 🛠️ Development Approach

### Directory Structure for Repo Contribution

```
subscription-service/
├── onchain/
│   └── aiken/          # Smart contract validator
└── offchain/
    ├── meshjs/         # JavaScript/TypeScript wallet integration
    └── nextjs/         # Frontend application example
```

### Implementation Flexibility

This design works across multiple paradigms:

- **Pure On-Chain**: Full smart contract automation
- **Hybrid**: Smart contract state + off-chain service logic
- **Pure Off-Chain**: Wallet applications with oracle verification
- **Cross-Chain**: Bridge patterns for multi-protocol subscriptions

### Development Process

1. **State Design**: Define minimal datum for UTxO efficiency
2. **Validation Logic**: Implement payment/time rules
3. **Off-Chain Integration**: Wallet + service provider APIs
4. **Testing**: Preview/Preprod testnet validation
5. **Documentation**: Clear integration patterns for dApp developers

### Cardano Integration Patterns

- **UTxO Queries**: `get_utxos_at_script_address`
- **Time Validation**: POSIX timestamp range checks
- **Multi-Asset**: ADA payments + tier NFTs
- **Wallet Compatibility**: Nami, Eternl, NuFi, Lace
- **Explorer Integration**: CardanoScan, AdaStat APIs

## 🤝 Contributing

Perfect fit for the Cardano Foundation ecosystem monitoring repo:

1. Open GitHub issue proposing "Subscription Service" use case
2. Fork main repository and create feature branch
3. Implement on-chain validator + off-chain examples
4. Add comprehensive README and test cases
5. Submit pull request following contribution guidelines

## ⚠️ Disclaimer

Educational template for Cardano ecosystem development. Production systems require professional security audits. Test extensively on testnets before mainnet deployment. Understand smart contract risks before using real funds.

**Multi-implementation approach enables rapid prototyping across on-chain and off-chain paradigms while maintaining consistent subscription mechanics.**[1]

[1](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring)
