# Editable NFT – Reference Implementation

This repository demonstrates a simple **Editable NFT** use case based on the Rosetta smart contract specifications.

The use case showcases a non-fungible token whose on-chain state can be updated by its owner until it is explicitly sealed. It is intended as a clear, minimal reference for understanding how editable and immutable phases of an NFT lifecycle can be modeled and enforced using smart contracts.

---

## Overview

An **Editable NFT** is a non-fungible token that:

* Is identified by a unique **token name**
* Stores arbitrary on-chain **payload data**
* Has an associated **owner**
* Can be **edited by the owner**
* Can be **sealed**, after which it becomes immutable

Once sealed, no further edits or ownership changes are allowed.

---

## Actors

This use case involves two actors:

* **Owner1** – the initial owner who mints and edits the NFT
* **Owner2** – a secondary owner who receives the NFT via transfer

---

## On-chain Model

The NFT is represented by:

* A **one-shot minting policy** used only during creation
* A **state script** that holds the NFT state via an inline datum

The state datum contains:

* `owner` – public key hash of the current owner
* `sealed` – boolean flag indicating immutability
* `payload` – arbitrary data associated with the NFT

---

## Lifecycle

The following sequence of actions is supported.

### 1. Buy / Mint Token (Owner1)

* Owner1 mints a new NFT
* Initial payload is provided at mint time
* Ownership is assigned to Owner1
* The minting step outputs:

    * `policyId`
    * `assetName`

These values uniquely identify the NFT and are required for all future interactions.

---

### 2. Edit Token (Owner1)

* Owner1 updates the payload stored in the NFT state
* This action is allowed only if:

    * The caller is the current owner
    * The NFT is **not sealed**

---

### 3. Transfer Token (Owner1 → Owner2)

* Owner1 transfers ownership of the NFT to Owner2
* The owner field in the state datum is updated
* The NFT remains editable unless sealed later

---

### 4. Seal Token (Owner2)

* Owner2 seals the NFT
* Once sealed:

    * The payload can no longer be modified
    * Ownership can no longer be changed
* This action is irreversible

---

## Off-chain Interface (CLI)

The repository includes a simple command-line interface implemented in **TypeScript (MeshJS + Deno)** to interact with the contracts.

Each command follows the general pattern:

```bash
deno run -A editable-nft-cli-test.ts <command> <arguments...>
```

If an incorrect number of arguments is provided, the script is expected to fail early.

---

## Command Reference

Below is a detailed reference of each supported command, its parameters, and their meaning. The parameter order directly reflects the function signatures in the TypeScript implementation.

---

### 1️⃣ Mint Editable NFT

Creates a new editable NFT, initializes its state, and locks it at the state script address.

#### Usage

```bash
deno run -A editable-nft-cli-test.ts mint <walletFile> <tokenName> <payload>
```

#### Parameters

| Parameter    | Description                                                      |
| ------------ | ---------------------------------------------------------------- |
| `walletFile` | Path to a wallet JSON file (mnemonic words) used to mint the NFT |
| `tokenName`  | Human-readable token name (will be hex-encoded on-chain)         |
| `payload`    | Initial payload stored in the NFT state datum                    |

#### Example

```bash
deno run -A editable-nft-cli-test.ts mint wallet_0.json "firefly" "crafted-by-alice"
```

#### Example Output

```text
ownerPkh:  72b46a9927fd32da5c2f11365b6f20f9af930e63974e4f8935064215
📦 NFT minted: Tx Id: 14e6306e028e1465fdba101528c493ec118331848c26b88d2c89b57bd7e469ea
policyId : 2868ca31fcd7549f568083411b68f15e9668e09a723a25d36f75ab24
assetName: 66697265666c79
```

The printed `policyId` and `assetName` must be preserved for all subsequent operations.

---

### 2️⃣ Update Payload / Transfer Ownership

Updates the NFT state. In this reference implementation, **payload updates and ownership changes are handled together** for simplicity.

#### Usage

```bash
deno run -A editable-nft-cli-test.ts update <walletFile> <policyId> <tokenName> <newOwnerPkh> <newPayload>
```

#### Parameters

| Parameter     | Description                                                      |
| ------------- | ---------------------------------------------------------------- |
| `walletFile`  | Wallet file of the **current owner**                             |
| `policyId`    | Policy ID returned during mint                                   |
| `tokenName`   | Original token name (same as mint)                               |
| `newOwnerPkh` | Payment key hash of the new owner (can be same as current owner) |
| `newPayload`  | Updated payload to store in the NFT state                        |

#### Example

```bash
deno run -A editable-nft-cli-test.ts update wallet_0.json 2868ca31fcd7549f568083411b68f15e9668e09a723a25d36f75ab24 "firefly" 332353c1231a76c19a9a7d44ef4252759e5feba6c9bb13a4c38ae712 "level-boost-2"
```
This single command updates the NFT state. In this reference implementation, payload updates and ownership changes are handled together for simplicity.

#### Example Output

```text
editable-nft\offchain\meshjs> deno run -A editable-nft-cli-test.ts update wallet_0.json 2868ca31fcd7549f568083411b68f15e9668e09a723a25d36f75ab24 "firefly" 332353c1231a76c19a9a7d44ef4252759e5feba6c9bb13a4c38ae712 "level-boost-2"
✏️ NFT state updated: Tx Id: acefcbd7044dd256a8c1c9b82305cf7fc3bf034a01f8e7cd7b70012bee8e12f1
```

Notes:

* The transaction **must be signed by the current owner**
* The update will fail if the NFT has already been sealed

---

### 3️⃣ Seal NFT

Seals the NFT, making both payload and ownership **permanently immutable**.

#### Usage

```bash
deno run -A editable-nft-cli-test.ts seal <walletFile> <policyId> <tokenName> <payload>
```

#### Parameters

| Parameter    | Description                           |
| ------------ | ------------------------------------- |
| `walletFile` | Wallet file of the current owner      |
| `policyId`   | Policy ID of the NFT                  |
| `tokenName`  | Token name used at mint time          |
| `payload`    | Final payload to be stored at sealing |

#### Example

```bash
deno run -A editable-nft-cli-test.ts seal wallet_1.json 2868ca31fcd7549f568083411b68f15e9668e09a723a25d36f75ab24 "firefly" "level-boost-2"
```

#### Example Output

```text
editable-nft\offchain\meshjs> deno run -A editable-nft-cli-test.ts seal wallet_1.json 2868ca31fcd7549f568083411b68f15e9668e09a723a25d36f75ab24 "firefly" "level-boost-2"
🔒 NFT sealed: Tx Id: 014ea42b96d02ea328405f3f637efe90e96db9e7c25305d5890f95b0a8f9e10c
```

Once sealed:

* Further `update` calls will fail
* Ownership can no longer be changed

---

## Notes on Parameters & Design

* `tokenName` is converted to hex internally using `stringToHex`
* The state script address is deterministically derived from:

    * `policyId`
    * `assetName`
* The implementation assumes **a single state UTxO** at the script address
* No indexing or UTxO selection strategy is implemented beyond the first match

---

## Purpose

This repository is intended to:

* Serve as a **reference implementation**
* Demonstrate **stateful NFTs** with editable and sealed phases
* Provide a clear example suitable for Catalyst / CF template repositories
* Be easy to read, audit, and extend

It is not production-hardened and omits advanced concerns such as indexing, batching, or multi-UTxO handling.
