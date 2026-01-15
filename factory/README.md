# Factory

A **Factory** allows a user to deterministically create and manage multiple **Product contracts**, where each Product is an independent on-chain contract instance with its own address and immutable identity.

This repository demonstrates a **Factory Pattern** for smart contracts on Cardano. The design preserves the intent of the traditional Factory Pattern listed in the rosetta-smart-contracts repository, while adapting it to Cardano’s UTxO-based execution model, where contract instances are expressed through parameterised scripts and off-chain orchestration.

---

## Overview

This implementation expresses the **Factory Pattern** in a way that is native to Cardano’s UTxO-based smart contract model.

The Factory–Product relationship is realised through:

* a **Factory identity** implemented as a minting policy (one per owner)
* **parameterised Product contracts**, where each parameter set yields a distinct on-chain address
* **off-chain orchestration** for contract instantiation, discovery, and interaction

Together, these components provide deterministic creation, verifiable provenance, and scalable management of independent Product contracts, while remaining fully aligned with Cardano’s execution and security model.

---

## Factory Contract

The Factory is implemented as a **minting policy**, parameterised by the owner’s
payment key hash (`owner_pkh`). In this design, the Factory identity is represented
by this minting policy (one per owner), and the terms “Factory” / “Factory identity” are used interchangeably to refer to it.

### Responsibilities

Once deployed, the Factory supports the following actions:

### `createProduct`

* Authorizes creation of a new Product contract
* Mints exactly **one Product NFT**
* The NFT asset name acts as the **product identifier**
* The Product contract is parameterised by:

  * `owner_pkh`
  * `factory_id`
  * `product_id`

A user-provided **tag string** is stored in the Product’s on-chain datum.

---

### `getProducts` (off-chain)

* Returns the list of Products created by the owner
* Product discovery starts by identifying on-chain UTxOs that hold assets minted
  under the Factory identity
* From each such UTxO:
  - the **product identifier** is obtained from the NFT asset name
  - the presence of the Factory-minted asset establishes provenance
* The corresponding Product contract address is then derived deterministically
  from the Product validator parameters, using the on-chain product identifier
  obtained from the UTxO.

This approach combines **on-chain UTxO inspection** with **deterministic contract derivation**, allowing Products to be reliably discovered and verified without maintaining an explicit registry.

---

## Product Contract

Each Product is an **independent contract** with its own script hash and address.

### Identity

A Product contract is uniquely defined by its validator parameters:

* `owner_pkh`
* `factory_id`
* `product_id`

These parameters are immutable and form part of the script hash.

### On-chain State

```text
ProductDatum {
  tag : ByteArray
}
```

Only mutable product-specific state is stored in the datum.
Ownership and factory provenance are enforced via validator parameters.

---

### Supported Actions

#### `getTag`

* Reads the tag stored in the Product’s on-chain datum
* Only the original creator (owner) is authorized to spend or interact with the Product UTxO

#### `getFactory`

* Returns the Factory identity that created the Product
* Implemented off-chain by deriving the Factory policy from the owner
* The Factory identity is cryptographically bound into the Product validator parameters

---

## On-chain

### Aiken

#### Prerequisites

* [Aiken](https://aiken-lang.org/installation-instructions#from-aikup-linux--macos-only)

#### Build and test

```sh
cd onchain/aiken
aiken check
aiken build
```

---

## Off-chain (MeshJS)

All off-chain logic is implemented in a **single MeshJS file**, covering all endpoints defined in the specification.

### Responsibilities

The off-chain code handles:

* Factory policy instantiation
* Product contract instantiation
* Product NFT minting
* Datum construction
* Chain querying and discovery
* CLI-based interaction for testing and demos

---

## CLI Usage

The following commands can be used to interact with the contracts.

---

### Create Product

Creates a new Product contract, mints its identifier NFT, and locks it at the Product script address.

**Command format**

```sh
deno run -A factory.ts create-product <wallet.json> <product_id> <tag>
```

**Example**

```sh
deno run -A factory.ts create-product wallet_0.json firefly-002 organic-honey
```

**Arguments**

* `wallet_0.json` — owner wallet file
* `firefly-002` — product identifier
* `organic-honey` — tag stored in Product datum

**Example Output**

```text
ownerPkh:  72b46a9927fd32da5c2f11365b6f20f9af930e63974e4f8935064215
Product contract created
Owner PKH: 72b46a9927fd32da5c2f11365b6f20f9af930e63974e4f8935064215
Factory policy: c69b1f737aee7fbf902a453ebb83674623f74a90d13a833ce0222005
Product contract address: addr_test1wr2dy9h26gyxnmm7m69f3p0g44mrnvvs8zhrnzm49gh9urgakmd2w
Tx hash: e9d85d8254340c23ae6589632824e244cff55b91b603b1e2cb477a66bdcd1b29
```

---

### Get Products

Returns the Products created by the given owner.

**Command format**

```sh
deno run -A factory.ts get-products <owner_pkh>
```

**Example**

```sh
deno run -A factory.ts get-products 72b46a9927fd32da5c2f11365b6f20f9af930e63974e4f8935064215
```

**Arguments**

* `owner_pkh` — owner payment key hash

**Example Output**

```text
Products fetched: [
  {
    productId: "firefly-001",
    policyId: "c69b1f737aee7fbf902a453ebb83674623f74a90d13a833ce0222005",
    fingerprint: "asset1hez9j04caycjx7kpk7r76ya85nelc3zlpawgwk"
  },
  {
    productId: "firefly-002",
    policyId: "c69b1f737aee7fbf902a453ebb83674623f74a90d13a833ce0222005",
    fingerprint: "asset1hs6kc669zjhzk3mmnkc78c4mh5seuhnrarre8x"
  },
  {
    productId: "firefly-009",
    policyId: "c69b1f737aee7fbf902a453ebb83674623f74a90d13a833ce0222005",
    fingerprint: "asset19stx7u2v58z5ma3ah7qnq8zr22uelmcn70qt3f"
  }
]
```

> Product discovery is performed off-chain using the Factory’s minting policy to identify Product NFTs.

---

### Get Product Tag

Reads the tag stored in a Product contract.

**Command format**

```sh
deno run -A factory.ts get-tag <owner_pkh> <product_id>
```

**Example**

```sh
deno run -A factory.ts get-tag 72b46a9927fd32da5c2f11365b6f20f9af930e63974e4f8935064215 firefly-002
```

**Arguments**

* `owner_pkh` — owner payment key hash
* `product_id` — product identifier

**Example Output**

```text
Product tag: 6f7267616e69632d686f6e6579
```

---

### Get Factory

Returns the Factory identity derived from the owner.

**Command format**

```sh
deno run -A factory.ts get-factory <owner_pkh>
```

**Example**

```sh
deno run -A factory.ts get-factory 72b46a9927fd32da5c2f11365b6f20f9af930e63974e4f8935064215
```

**Example Output**

```json
{
  "ownerPkh": "72b46a9927fd32da5c2f11365b6f20f9af930e63974e4f8935064215",
  "policyId": "c69b1f737aee7fbf902a453ebb83674623f74a90d13a833ce0222005"
}
```

---

## Design Notes

* Each Product is a true contract, not merely a datum instance
* Factory-Product provenance is cryptographically enforced
* No mutable registries or shared state are required
* Discovery is performed off-chain, consistent with Cardano’s UTxO model
* The design maps cleanly to the original Factory Pattern specification while remaining Cardano-native

---

## Disclaimer

This project is intended as a reference implementation and educational example.
It has not been audited and should not be used with real funds without proper review and testing.

---
