# Anonymous Data

An **anonymous, commitment-based data storage contract** implemented in Aiken on Cardano.

Users commit data on-chain using a cryptographic identifier derived off-chain from their wallet and a secret nonce. Ownership is later proven by revealing the nonce and signing the spending transaction.

The contract uses a standard **commit–reveal pattern** and does not store public key hashes on-chain.

---

## How it works

A user derives an identifier **off-chain**:

```

id = blake2b_256(pkh || nonce)

````

* `pkh` is the public key hash of a transaction signer
* `nonce` is a user-chosen secret
* `id` is used as the **asset name** of a singleton native token

### Commit (store data)

* Exactly one token with asset name = `id` is minted
* The token is locked at the script address
* The output **must carry an inline datum**, whose contents are user-defined
* No ownership or signature checks are performed in this phase

### Reveal (retrieve data)

* The user spends the script UTxO
* The redeemer supplies the original nonce
* The validator recomputes `blake2b_256(pkh || nonce)` for each signer
* The spend succeeds if any signer reproduces the committed `id`

---

## ⛓ On-chain

### Aiken

#### Prerequisites

* [Aiken](https://aiken-lang.org/installation-instructions#from-aikup-linux--macos-only)

#### Test and build

```zsh
cd onchain/aiken
aiken check
aiken build
````

---

## 📄 Off-chain

### MeshJS (Deno)

#### Prerequisites

* Deno ([https://deno.land/](https://deno.land/))
* A funded wallet on preprod

#### Commit data

Locks arbitrary data at the script address under an anonymous commitment.

```zsh
deno run -A anonymous-data.ts commit <wallet.json> <nonce> <data>
```

Example:

```zsh
deno run -A anonymous-data.ts commit wallet_0.json nonce-729873 escrow-record-key-01
```

Output includes the derived commitment ID and submitted transaction hash.

---

#### Reveal data

Proves ownership and spends the committed UTxO by revealing the nonce.

```zsh
deno run -A anonymous-data.ts reveal <wallet.json> <nonce>
```

Example:

```zsh
deno run -A anonymous-data.ts reveal wallet_0.json nonce-729873
```

The transaction succeeds only if the signer can reproduce the original commitment.

---

## Notes

* The nonce must be generated off-chain with sufficient entropy
* Commitments are unlinkable to public keys until reveal
* On-chain data is public; this contract does not provide data confidentiality
* Users may reuse the same wallet with different nonces to create multiple commitments

---

## Scope

This project demonstrates:

* anonymous on-chain commitments
* ownership proofs without persistent identity storage
* a Cardano-native implementation of the Rosetta “Anonymous Data” specification

It is intended as a **reference implementation** and should be audited before production use.
