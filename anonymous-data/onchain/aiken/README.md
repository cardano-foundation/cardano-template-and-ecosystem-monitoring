# Anonymous Data (Aiken)

This Aiken smart contract implements an **anonymous, commitment-based data ownership pattern** on Cardano using a standard **commit–reveal mechanism**.

A user derives a commitment identifier off-chain as:

```
id = blake2b_256(pkh || nonce)
```

where:

* `pkh` is the public key hash of a transaction signer,
* `nonce` is a secret byte array chosen by the user,
* `||` denotes **byte-level concatenation**.

The identifier is committed on-chain without storing or revealing the public key hash.
Ownership is later proven by revealing the nonce and signing the spending transaction, allowing the validator to recompute and verify the identifier.

---

## Design Overview

The contract consists of two logical phases:

* **Commit phase** implemented as a **minting policy**
* **Reveal phase** implemented as a **spending validator**

### Commitment Representation

* The commitment identifier (`id`) is represented **exclusively** as the **asset name of a singleton token**.
* Arbitrary user data may be stored as **inline datum** at the script output.
* The datum contents are treated as opaque and are **not interpreted**,
  but the **presence of an inline datum is enforced on-chain**.

No public key hash is stored in:

* script parameters,
* datum,
* redeemers.

---

## Commit Phase (Mint)

The commit phase records the commitment identifier on-chain without proving ownership.

### Behaviour

* Exactly one token is minted.
* The token’s **asset name equals the commitment identifier (`id`)**.
* The minted token must appear in at least one transaction output.
* That output must carry an **inline datum**, whose contents are user-defined.

### Guarantees

* The nonce is **not revealed**.
* No ownership or signature checks are performed in the commit phase.
* The commitment is unlinkable to any public key via on-chain data alone.

### Mint Logic (Simplified)

```aiken
mint(id: ByteArray, policy_id: PolicyId, tx: Transaction) {
  -- exactly one token with asset name = id is minted
  -- the token appears in at least one output
  -- that output carries an inline datum
}
````

The minting policy enforces **structural correctness only**, deferring ownership verification entirely to the spend phase.

---

## Reveal Phase (Spend)

Ownership is proven when the committed script output is spent.

### Behaviour

* The redeemer supplies the original `nonce`.
* The transaction must include at least one signer.
* The validator extracts the commitment identifier from the **asset name** of the spent UTxO.
* For each transaction signatory, the validator recomputes:

```
blake2b_256(pkh || nonce)
```

* The spend is permitted if **any** recomputed value matches the committed identifier.

### Spend Logic (Simplified)

```aiken
spend(
  _datum: Option<Data>,
  nonce: ByteArray,
  oref: OutputReference,
  tx: Transaction,
) {
  -- let committed_id be the asset name of the spent token
  -- allow spend if ∃ signer pkh such that:
  -- blake2b_256(concat(pkh, nonce)) == committed_id
}
```

The inline datum is intentionally ignored and may contain arbitrary user-defined data.

---

## Anonymity and Disclosure Model

* **Before spend**
  Commitments are unlinkable to any public key hash via on-chain data.

* **At spend**
  The owner intentionally reveals control by supplying the nonce and a valid signature.

This contract provides **unlinkability until reveal**, not permanent anonymity.
This is an intentional and standard commit–reveal construction.

---

## On-chain Implementation

### Aiken

#### Prerequisites

* [Aiken](https://aiken-lang.org/installation-instructions#from-aikup-linux--macos-only)

#### Build and Test

```sh
cd onchain/aiken
aiken check
aiken build
```

---

## Notes and Assumptions

* The `nonce` must be generated off-chain with sufficient entropy.
* `ByteArray` is used for the nonce to avoid serialization ambiguity.
* `blake2b_256` is used as it is the native hash function in Plutus.
* Transaction signatories are public by design; anonymity relies on unlinkability prior to reveal.
* On-chain data is public; this contract does **not** provide data confidentiality.

---

## Scope

This contract demonstrates:

* anonymous on-chain commitments,
* ownership proof without persistent identity storage,
* Cardano-native commit–reveal semantics.

It is intended as a reference implementation.

