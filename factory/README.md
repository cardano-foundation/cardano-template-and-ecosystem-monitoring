# Factory Pattern

This repository implements a **Cardano-native Factory Pattern** for deterministically creating and managing multiple **Product contracts**, using **marker tokens**, **parameterised validators**, and **off-chain orchestration**.

The design is fully aligned with Cardano’s **UTxO execution model** and adapts the classical Factory Pattern (like described in `rosetta-smart-contracts` spec) to a setting where:

* contracts are expressed as parameterised scripts,
* global mutable registries are avoided,
* and state evolution is enforced through UTxO continuity.

---

## High-level Design

The system is composed of **three validators**:

1. **Factory Marker (Minting Policy)**
2. **Factory (Mint + Spend Validator)**
3. **Product (Spend Validator)**

The lifecycle is:

```
one-shot UTxO
   ↓
Factory Marker minted
   ↓
Factory state UTxO created
   ↓
Products created via Factory
```

Each step is cryptographically enforced on-chain.

---

## Core Concepts

### Factory Marker

The **Factory Marker** establishes a *unique Factory instance* for an owner.

* Minted **exactly once**
* Uses a **one-shot UTxO** as entropy
* Produces a single NFT: `FACTORY_MARKER`
* The marker NFT is **locked at the Factory script address**
* Its policy ID becomes the **Factory identity**

This avoids ambiguity and ensures that each Factory instance is globally unique and verifiable.

---

### Factory

The **Factory** is a stateful on-chain contract that:

* Holds the `FACTORY_MARKER` NFT
* Maintains an on-chain registry of Products
* Authorizes creation of new Products

#### Factory Datum

```text
FactoryDatum {
  products : List<PolicyId>
}
```

* Each entry corresponds to a **Product minting policy**
* This registry is the **source of truth** for product discovery

---

### Product

Each **Product** is an independent contract instance with:

* Its own script hash
* Its own address
* Immutable identity

#### Product Datum

```text
ProductDatum {
  tag : ByteArray
}
```

The tag is user-defined metadata (e.g. label, SKU, description pointer).

---

## On-chain Responsibilities

### 1. Factory Marker Validator

```aiken
validator factory_marker(
  owner: VerificationKeyHash,
  utxo_ref: OutputReference,
)
```

**Responsibilities**

* Enforces one-shot minting using `utxo_ref`
* Requires owner signature
* Mints exactly one `FACTORY_MARKER` NFT
* Ensures the marker NFT is locked at the Factory script address

---

### 2. Factory Validator

```aiken
validator factory(
  owner: VerificationKeyHash,
  factory_marker_policy: PolicyId,
)
```

**Mint branch**

* Authorizes Product creation
* Requires:

    * owner signature
    * exactly one Factory Marker input
* Mints exactly one Product NFT
* Ensures Product output:

    * is locked at a Product script address
    * contains a valid `ProductDatum`

**Spend branch**

* Enforces Factory state continuity
* Requires:

    * Factory Marker stays at the Factory address
    * updated Factory datum includes the new Product policy ID

---

### 3. Product Validator

```aiken
validator product(
  owner: VerificationKeyHash,
  factory_id: PolicyId,
  product_id: ByteArray,
)
```

**Responsibilities**

* Binds Product to:

    * owner
    * Factory identity
    * product identifier
* Authorizes spends only by the owner

---

## Off-chain (MeshJS)

All off-chain logic is implemented in a **single MeshJS file**, handling:

* Script parameterisation
* Factory creation
* Product creation
* Datum construction
* Chain querying
* CLI interaction

No off-chain registry is required; discovery is derived from on-chain state.

---

## CLI Usage

### Create Factory

Creates a new Factory instance by minting the Factory Marker and locking it at the Factory address.

```sh
deno run -A factory.ts create-factory <wallet.json>
```

**Example**

```sh
deno run -A factory.ts create-factory wallet_0.json
```

**Example Output**

```text
Factory created
Owner PKH: 332353c1231a76c19a9a7d44ef4252759e5feba6c9bb13a4c38ae712
Factory address: addr_test1wzt96tly6jjtjzcqf2k3w7yvjavm2uwq72qsfwjzdesf5ls90pgvw
Factory marker policy: d8e6160ad3e69f1976e33cba6bb9769a283c6aa4a28121a70744cb77
Tx hash: 53910d7e52fc51903025e53d39ab81e228576ec5a9daf80bd33b60006a5dbad1
```

---

### Get Factory

Checks whether a Factory exists and prints its derived details.

```sh
deno run -A factory.ts get-factory <wallet.json> <marker_policy_id>
```

**Example**

```sh
deno run -A factory.ts get-factory wallet_0.json d8e6160ad3e69f1976e33cba6bb9769a283c6aa4a28121a70744cb77
```

**Example Output**

```text
--- Factory status ---
Owner PKH: 332353c1231a76c19a9a7d44ef4252759e5feba6c9bb13a4c38ae712
Factory marker policy: d8e6160ad3e69f1976e33cba6bb9769a283c6aa4a28121a70744cb77
Factory script hash: 965d2fe4d4a4b90b004aad17788c9759b571c0f28104ba426e609a7e
Factory address: addr_test1wzt96tly6jjtjzcqf2k3w7yvjavm2uwq72qsfwjzdesf5ls90pgvw
Factory created: true
```

---

### Create Product

Creates a new Product contract and registers it in the Factory.

```sh
deno run -A factory.ts create-product <wallet.json> <marker_policy_id> <product_id> <tag>
```

**Example**

```sh
deno run -A factory.ts create-product wallet_0.json d8e6160ad3e69f1976e33cba6bb9769a283c6aa4a28121a70744cb77 product_id_1 tag_solarpanel_v1
```

**Example Output**

```text
Product created
Product address: addr_test1wqfra7j2lfvl3g760jg73seses4af2hq7x3l8cqgsz9gvcgy24uy9
Tx hash: 66191c0d83745266aed4b1f4da9231f512047960adc9289693acb7ee0ac4294e
```

---

### Get Products

Reads the Factory’s on-chain registry and lists all Products.

```sh
deno run -A factory.ts get-products <wallet.json> <marker_policy_id>
```

**Example**

```sh
deno run -A factory.ts get-products wallet_0.json d8e6160ad3e69f1976e33cba6bb9769a283c6aa4a28121a70744cb77
```

**Example Output**

```text
Factory product policy IDs: [
  { bytes: "123efa4afa59f8a3da7c91e8c330cc2bd4aae0f1a3f3e008808a8661" }
]
Products fetched: [
  {
    productId: "product_id_1",
    policyId: "123efa4afa59f8a3da7c91e8c330cc2bd4aae0f1a3f3e008808a8661",
    fingerprint: "asset1ppyl0e9g56e2j2waz3ytv2h3yns6skhpgs7w3p"
  }
]
```

---

### Get Product Tag

Reads the tag stored in a Product’s datum.

```sh
deno run -A factory.ts get-tag <wallet.json> <marker_policy_id> <product_id>
```

**Example**

```sh
deno run -A factory.ts get-tag wallet_0.json d8e6160ad3e69f1976e33cba6bb9769a283c6aa4a28121a70744cb77 product_id_1
```


**Example Output**

```text
--- Product details ---
Product ID: product_id_1
Product policy: 123efa4afa59f8a3da7c91e8c330cc2bd4aae0f1a3f3e008808a8661
Product address: addr_test1wqfra7j2lfvl3g760jg73seses4af2hq7x3l8cqgsz9gvcgy24uy9
Tag: tag_solarpanel_v1
```

---

## Design Notes

* Factory identity is established via a **marker NFT**
* Factory state is enforced through **UTxO continuity**
* Products are **true contracts**, not datum instances
* Discovery is derived from **on-chain state**, not off-chain registries

---

## Disclaimer

This repository is a **reference implementation** and **educational example**.

It has not been audited and should not be used with real funds without independent security review.

