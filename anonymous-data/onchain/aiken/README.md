# Anonymous Data (Aiken)

This Aiken smart contract implements an **anonymous, commitment-based data ownership pattern** on Cardano using a standard **commit–reveal mechanism**.

A user derives an identifier off-chain as concatenation of pkh and nonce:

```

id = blake2b_256(pkh || nonce)

````

where `||` denotes **byte concatenation**.

The identifier is committed on-chain without revealing the public key hash (`pkh`).
Ownership is later proven by revealing the nonce and signing the spending transaction, allowing the validator to recompute and verify the identifier.

---

## Design Overview

The contract is composed of two phases:

- a **minting policy** (commit phase)
- a **spending validator** (reveal phase)

The validator is parameterised by:

- `script_hash : ScriptHash` — the script address at which the committed data must be locked

The following values are provided dynamically:

- `id : ByteArray` — commitment identifier (mint phase)
- `nonce : ByteArray` — secret revealed during spend (reveal phase)

No public key hash is stored in script parameters or datum.

---

## Commit Phase (Mint)

The commit phase records the identifier on-chain without proving ownership.

### Behaviour

- Exactly one marker token is minted.
- The marker token is deposited at the validator script address.
- The inline datum of the script output equals the committed `id`.

### Guarantees

- The nonce is **not revealed**.
- No signer or ownership checks are performed.
- The commitment is unlinkable to any public key.

### Mint Logic (Simplified)

```aiken
mint(id: ByteArray, policy_id: PolicyId, tx: Transaction) {
  -- exactly one marker token is minted
  -- the token is deposited at the script_hash address
  -- the inline datum equals the committed id
}
````

The minting policy enforces **structural correctness only**, deferring ownership checks to the spend phase.

---

## Reveal Phase (Spend)

Ownership is proven when the script UTxO is spent.

### Behaviour

* The redeemer supplies the original `nonce`.
* The transaction must be signed.
* For each transaction signatory, the validator recomputes:

```
blake2b_256(pkh || nonce)
```

* The spend is allowed if **any** recomputed value matches the committed `id`.

### Spend Logic (Simplified)

```aiken
spend(
  _datum: Option<Data>,
  nonce: ByteArray,
  _utxo: OutputReference,
  tx: Transaction,
) {
  -- allow spend if ∃ signer pkh such that:
  -- blake2b_256(concat(pkh, nonce)) == committed_id
}
```

---

## Anonymity and Disclosure Model

* **Before spend**
  The committed data is unlinkable to any public key.

* **At spend**
  The owner intentionally reveals identity by providing the nonce and signature.

This contract provides **unlinkability until reveal**, not permanent anonymity.
This is an intentional and standard commit–reveal construction.

---

## On-chain

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

* `nonce` must be generated off-chain with sufficient entropy.
* `ByteArray` is used for the nonce to avoid serialization ambiguity.
* `blake2b_256` is used as it is the native hash function in Plutus.
* Transaction signatories are public by design; anonymity relies on unlinkability prior to reveal.
* On-chain data is public; this contract does **not** provide data confidentiality.

---

## Scope

This contract demonstrates:

* anonymous on-chain commitments
* ownership proof without persistent identity storage
* Cardano-native commit–reveal semantics

It is intended as a **reference implementation** and should be audited before use in production systems.
