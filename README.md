### Cardano Blueprint and Ecosystem Monitoring

The goal of this repository is to implement the 21 most common blockchain use cases for Cardano using as many on-chain and off-chain frameworks and languages as possible. This will allow developers to use these implementations as blueprints for their own projects while also enabling us to monitor the Cardano ecosystem and its development. Essentially, this project aims to create a map and ecosystem monitoring tool for combinations of on-chain and off-chain technologies, as well as an ecosystem readiness check for upcoming Cardano hard forks.

## 🎡 Overview

This repository is divided into directories based on use cases and the technologies used for their implementation. The structure is as follows:

- `/use-case/onchain/<technology>/`: Contains the on-chain implementation of a specific use case using a particular technology (e.g. aiken, scalus, plu-ts, etc.).
- `/use-case/offchain/<framework>/`: Contains the off-chain implementation of the same use case using a specific framework (e.g. meshjs, lucid-evolution, cardano-client-lib, etc.).

For example:
- `/payment-splitter/onchain/aiken/`
- `/payment-splitter/offchain/meshjs/`

The use cases implemented in this repository are based on the research paper [Smart Contract Languages: A Comparative Analysis](https://arxiv.org/abs/2404.04129) by Massimo Bartoletti et al. (2024). An on-chain implementation for Cardano in `aiken` and in other languages for other blockchain ecosystems are already available in the [rosetta-smart-contracts repository](https://github.com/blockchain-unica/rosetta-smart-contracts).

### Use Cases

The 21 use cases identified in the research paper are as follows:

1. [Bet](bet/README.md)  
2. Simple transfer  
3. Token transfer  
4. HTLC  
5. [Escrow](escrow/README.md)  
6. Auction  
7. Crowdfund  
8. Vault  
9. [Vesting](vesting/README.md)  
10. Storage  
11. Simple wallet  
12. Price Bet  
13. [Payment splitter](payment-splitter/README.md)
14. Lottery  
15. Constant-product AMM  
16. Upgradeable Proxy  
17. Factory  
18. Decentralized identity  
19. Editable NFT  
20. Anonymous Data  
21. Atomic Transactions  

### 🛠 Running a Use Case

Each use case is implemented in its own directory. To run a specific use case, navigate to its directory and follow the instructions provided in its README file. (E.g. [here](payment-splitter/README.md))

## 💙 Contributing

We welcome contributions from the community! If you would like to contribute, please follow these steps:

1. Open an issue to discuss your proposed changes or additions.
2. Fork the repository and create a new branch for your changes.
3. Submit a pull request with a detailed description of your changes.

Please read the [Contributing Guidelines](CONTRIBUTING.md) before submitting your pull request. Thank you for contributing!

## 📚 Additional Documents

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security](SECURITY.md)