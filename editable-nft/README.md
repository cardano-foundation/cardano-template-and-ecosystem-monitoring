# 🎨 Editable NFT Smart Contract

A dynamic non-fungible token system built on Cardano, enabling **controlled on-chain mutability**, ownership transfer, and permanent sealing of token state.

This repository combines a **high-level conceptual overview** with a **concrete reference implementation**, making it suitable both as educational material and as a hands-on developer starting point.

---

## 🌟 What is an Editable NFT?

Traditional NFTs are immutable once minted, which limits their usefulness for assets that evolve over time. Common limitations include:

* Static metadata that cannot be updated
* No mechanism for correcting or improving content
* Poor fit for game assets or stateful digital items
* No clean way to permanently finalize content when needed

An **Editable NFT** introduces **controlled mutability**:

* The current owner can update on-chain data
* Ownership can be transferred along with editing rights
* The owner may permanently **seal** the NFT
* Once sealed, the NFT becomes fully immutable

This design preserves trust while enabling flexibility during an asset’s lifecycle.

---

## 💎 Key Benefits

### 🔄 Dynamic Content Updates

* Token data can be updated by the current owner
* Supports evolving metadata and stateful assets
* Multiple edits allowed prior to sealing
* Arbitrary payload data supported

### 🌐 Ownership Transfer Control

* Explicit ownership transfer mechanism
* Editing rights move with ownership
* Clear and auditable state transitions

### 🔍 Permanent Sealing

* Owner can irreversibly seal the NFT
* Prevents any future payload or ownership changes
* Enables strong immutability guarantees when required

### ⚖️ Clear Lifecycle Phases

* **Editable phase**: owner may update state
* **Transfer phase**: ownership can change
* **Sealed phase**: NFT becomes immutable

---

## 🏗️ Architecture Overview

### Ownership-Based Editing Model

The contract enforces a simple and explicit permission model:

* ✅ Only the current owner may update token state
* ✅ Ownership transfer updates editing rights
* ✅ Any owner may permanently seal the NFT
* ❌ No edits or transfers allowed after sealing

This ensures predictable behavior and minimizes on-chain complexity.

---

## 🔄 Contract Workflow

### Step 1: Mint / Acquire Token (Owner1)

* A new editable NFT is minted
* Initial payload is set at creation time
* Ownership is assigned to the minter
* Token starts in an **unsealed**, editable state

---

### Step 2: Edit Token (Owner1)

* Owner updates the NFT payload
* Allowed only if:

    * Caller is the current owner
    * Token is not sealed

---

### Step 3: Transfer Ownership (Owner1 → Owner2)

* Ownership is transferred to a new party
* Editing rights move to the new owner
* Token remains editable unless sealed later

---

### Step 4: Seal Token (Owner2)

* Owner permanently seals the NFT
* Payload and ownership become immutable
* This action is irreversible

---

## 📋 Contract Specification

### Core State Fields

* **token name**: unique identifier of the NFT
* **owner**: payment key hash of the current owner
* **payload**: arbitrary on-chain data
* **sealed**: boolean indicating immutability

### Supported Actions

* **mint / buy**: create a new editable NFT
* **update**: modify payload and/or owner (if unsealed)
* **seal**: permanently lock NFT state

Unauthorized actions or invalid state transitions cause the transaction to fail.

---

## 🧩 Reference Implementation

This repository includes a **minimal, concrete implementation** of the Editable NFT model, designed to be easy to read, audit, and extend.

### Overview

The reference implementation demonstrates:

* A stateful NFT whose datum can be updated by its owner
* A clear transition from editable → sealed state
* Enforcement of ownership and sealing rules on-chain

Once sealed, **no further edits or ownership changes are allowed**.

---

## 👥 Actors

* **Owner1** – initial owner who mints and edits the NFT
* **Owner2** – secondary owner who receives the NFT via transfer

---

## ⛓️ On-chain Model

The NFT is implemented using:

* A **one-shot minting policy** (used only during creation)
* A **state validator script** holding a single state UTxO

The inline datum contains:

* `owner` – current owner’s public key hash
* `sealed` – boolean immutability flag
* `payload` – arbitrary NFT data

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
