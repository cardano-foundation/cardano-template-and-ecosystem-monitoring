# Anonymous Data

This Aiken smart contract implements an anonymous, commitment-based data storage mechanism.
Users generate an identifier off-chain as:

```
id = blake2b_256(pkh || nonce)
```

Data is stored on-chain under this identifier, without revealing the user’s public key.
Retrieval requires providing the original nonce and signing the spending transaction with the same key, allowing the validator to recompute the identifier and verify ownership.

Uniqueness is enforced by minting a single native token whose asset name equals the identifier. The associated UTxO stores a datum containing the identifier and an arbitrary payload.

## How It Works

### Store Data (Commit Phase)

* User selects a random nonce and computes `id = hash(pkh || nonce)` off-chain.
* A transaction:

    * Mints one token with asset name = `id`.
    * Creates a script UTxO storing:

        * `id`
        * `payload : ByteString`
    * Includes the token inside that output.
* Minting policy ensures:

    * Exactly one token is minted per identifier.
    * Minting is tied to creation of the script UTxO containing that `id`.

### Retrieve Data (Reveal Phase)

* User builds a transaction spending the script UTxO.
* Redeemer includes the original nonce.
* Validator:

    * Extracts signatories from the transaction.
    * Recomputes `blake2b_256(pkh || nonce)` for each signer.
    * Allows spending only if one matches the stored `id`.

This allows a user to prove ownership of the stored data without having revealed their public key during the commit phase.

---

## ⛓ On-chain

### Aiken

#### Prerequirements

* [Aiken](https://aiken-lang.org/installation-instructions#from-aikup-linux--macos-only)

#### Test and Build

```zsh
cd onchain/aiken
aiken check
aiken build
```

---

## 📄 Off-chain

Off-chain code is responsible for:

* Generating nonces
* Computing identifiers
* Building minting transactions for storing data
* Constructing retrieval transactions (with nonce and signature)

Any Cardano off-chain framework may be used, such as Mesh.js, Lucid Evolution, PyCardano, or the Cardano Client Lib.

Typical flow:

1. Generate `nonce`
2. Compute `id = blake2b_256(pkh || nonce)`
3. Mint token + create script UTxO with datum `{ id, payload }`
4. To retrieve, submit a spending transaction with `nonce` in redeemer and the wallet signature
