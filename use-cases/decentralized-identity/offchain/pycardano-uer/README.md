# Use Case: Unified Electoral Roll (UER)
**Project Category:** Decentralized Identity / Governance  
**Framework:** [PyCardano](https://github.com/Python-Cardano/pycardano)  
**Implementation Type:** Off-chain

## 📖 Description
The **Unified Electoral Roll (UER)** addresses the critical challenge of maintaining accurate, tamper-proof voter registries in modern democracies. Traditional centralized databases are prone to administrative errors, unauthorized alterations, and data silos that make voter mobility (registering in a new ward) a slow, manual process in India.

By utilizing the Cardano blockchain, this project creates a **Decentralized Identity** solution for voters. It allows electoral commissions to anchor voter registration data as immutable metadata on-chain. This ensures that a voter's registration status is globally verifiable, transparent, and portable across jurisdictions without relying on a single central server.

## 💎 Key Benefits
- **Self-Sovereign Identity:** Voters can prove their registration status using their own cryptographic keys.
- **Immutability:** Once a voter is registered via a transaction, the record cannot be deleted or "lost" by administrative staff.
- **Transparency:** Anyone can audit the electoral roll in real-time by querying the specific metadata label on the ledger.
- **Efficiency:** Drastically reduces the time required to verify voter credentials across different government departments.

## 🏗️ Architecture & Design
This implementation follows the **Off-chain** pattern, utilizing Python for high accessibility and rapid integration.

### Technical Design Decisions:
- **Metadata Anchoring:** We utilize **Metadata Label 12012026** to store structured JSON data containing the voter's name, ward ID, and verification status.
- **Conway Era Compatibility:** Designed to work within the latest Cardano ledger era, ensuring long-term compatibility.
- **Blockfrost Integration:** Uses the Blockfrost API for real-time interaction with the Cardano Preprod testnet.
- **Security:** The script separates the signing key (`.skey`) from the code logic, following best practices for key management.

## 🚀 How to Build and Run

### 1. Prerequisites
- Python 3.10 or higher
- [PyCardano](https://pycardano.tinypie.org/) library
- A [Blockfrost](https://blockfrost.io/) API Key for the **Preprod** network.

### 2. Installation
```bash
# Clone the repository
git clone [https://github.com/silversoul8668/cardano-template-and-ecosystem-monitoring.git](https://github.com/silversoul8668/cardano-template-and-ecosystem-monitoring.git)
cd cardano-template-and-ecosystem-monitoring/use-cases/decentralized-identity/offchain/pycardano-uer

# Install dependencies
pip install pycardano