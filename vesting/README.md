# Vesting

Vesting contract is a smart contract that locks up funds for a period of time and allows the beneficiary to withdraw the funds after the lockup period.

When a new employee joins an organization, they typically receive a promise of compensation to be disbursed after a specified duration of employment. This arrangement often involves the organization depositing the funds into a vesting contract, with the employee gaining access to the funds upon the completion of a predetermined lockup period. Through the utilization of vesting contracts, organizations establish a mechanism to encourage employee retention by linking financial rewards to tenure.

There are 2 actions (or endpoints) available to interact with this smart contract:

- deposit asset
- withdraw asset

[Read more and live demo](https://meshjs.dev/smart-contracts/vesting)

## Usage

To initialize the escrow, we need to initialize a provider, MeshTxBuilder and MeshVestingContract.

```
import { BlockfrostProvider, MeshTxBuilder } from '@meshsdk/core';
import { MeshVestingContract } from '@meshsdk/contracts';
import { useWallet } from '@meshsdk/react';

const { connected, wallet } = useWallet();

const provider = new BlockfrostProvider(APIKEY);

const meshTxBuilder = new MeshTxBuilder({
  fetcher: provider,
  submitter: provider,
});

const contract = new MeshVestingContract({
  mesh: meshTxBuilder,
  fetcher: provider,
  wallet: wallet,
  networkId: 0,
});
```

## 📄 Off-chain

### Apollo (Go)

This off-chain implementation uses [Apollo](https://github.com/Salvionied/apollo),
a pure-Go transaction builder built on the Blink Labs Cardano libraries —
[gouroboros](https://github.com/blinklabs-io/gouroboros) for ledger types, CBOR
and addresses, [bursa](https://github.com/blinklabs-io/bursa) for wallet
derivation and signing, and [plutigo](https://github.com/blinklabs-io/plutigo)
for Plutus data.

The scenario exercises both vesting paths: the owner's unconditional clawback,
and the beneficiary's time-gated claim (which sets a transaction validity start
strictly after `lock_until` to satisfy the validator's `valid_after` check).

#### Prerequisites

- [Go](https://go.dev/dl/) 1.21 or newer — `GOTOOLCHAIN=auto` (the default)
  fetches the 1.25 toolchain the module requires.
- A running [Yaci DevKit](https://devkit.yaci.xyz/) instance.

#### Usage

```zsh
cd offchain/apollo
go run .
```
