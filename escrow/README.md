# Escrow

<!-- CI_BADGE_BLOCK_BEGIN -->
[![Ecosystem tests · escrow](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml/badge.svg?branch=main)](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml)
<!-- CI_BADGE_BLOCK_END -->


Escrow contract facilitates the secure exchange of assets between two parties by acting as a trusted intermediary that holds the assets until the conditions of the agreement are met.
The escrow smart contract allows two parties to exchange assets securely. The contract holds the assets until both parties agree and sign off on the transaction.

There are 4 actions available to interact with this smart contract:

- initiate escrow and deposit assets
- deposit assets
- complete escrow
- cancel escrow

[Read more and live demo](https://meshjs.dev/smart-contracts/escrow)

## ⛓ On-chain

### Aiken

#### 🔌 Prerequirements

- [Aiken](https://aiken-lang.org/installation-instructions#from-aikup-linux--macos-only)

#### 🪄 Test and build

```zsh
cd onchain/aiken
aiken check
aiken build
```

## ⛓ Off-chain

## Usage

To initialize the escrow, we need to initialize a provider, MeshTxBuilder and MeshEscrowContract.

```
import { BlockfrostProvider, MeshTxBuilder } from '@meshsdk/core';
import { MeshEscrowContract } from '@meshsdk/contracts';
import { useWallet } from '@meshsdk/react';

const { connected, wallet } = useWallet();

const provider = new BlockfrostProvider(APIKEY);

const meshTxBuilder = new MeshTxBuilder({
  fetcher: provider,
  submitter: provider,
});

const contract = new MeshEscrowContract({
  mesh: meshTxBuilder,
  fetcher: provider,
  wallet: wallet,
  networkId: 0,
});
```