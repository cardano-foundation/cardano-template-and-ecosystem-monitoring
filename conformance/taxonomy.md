# Primitive taxonomy

The canonical list of protocol primitives the conformance suite tests. New primitives slot into one of the categories below; new categories are introduced when a primitive doesn't fit any existing one.

Categories are alphabetical within this file; the *implementation* order across milestones is encoding → tx-building → plutus-eval → governance. P2W1 ships only `encoding/`; P2W2 ships `tx-building/` and `plutus-eval/`.

## encoding

Pure functions of input → expected bytes/hash. No chain state, no Yaci. These run in milliseconds and are the cleanest fit for the teaching-unit model. A failure here usually means an SDK's CBOR or address codec drifted.

| Primitive | What it tests | Status |
|-----------|---------------|--------|
| [`datum-cbor-roundtrip`](primitives/encoding/datum-cbor-roundtrip/) | Plutus-data → CBOR encoding (and the matching `blake2b_256` datum hash). The most fundamental encoding primitive; every datum stored on-chain goes through this. | P2W1 ✅ |
| [`address-bech32-roundtrip`](primitives/encoding/address-bech32-roundtrip/) | Address bytes ↔ Bech32 string. Wallets, indexers, and SDKs all need to agree on this for any address to be exchangeable. | P2W1 ✅ |
| [`plutus-data-canonical-order`](primitives/encoding/plutus-data-canonical-order/) | Map-key ordering inside Plutus-data CBOR. Cardano canonicalises map keys; SDKs that emit non-canonical CBOR produce hashes that won't match other SDKs' or the ledger's. | P2W1 ✅ |
| `native-script-cbor` | Native (non-Plutus) script CBOR encoding. | TBD |
| `metadata-cbor` | Tx metadata (label-keyed CBOR) encoding. | TBD |
| `redeemer-encoding` | Redeemer wrapping with cost units, tag, and index. | TBD |

## tx-building

Building a complete `TransactionBody` from inputs, outputs, certificates, etc. Most need Yaci DevKit for protocol-parameter and fee calculations. P2W2 scope.

| Primitive | What it tests | Status |
|-----------|---------------|--------|
| `minimum-fee-calculation` | Given inputs/outputs/witnesses, compute the minimum required fee against pinned protocol parameters. | P2W2 |
| `ex-units-estimation` | Estimate Plutus execution units (memory + steps) for a script-spending tx. | P2W2 |
| `reference-script-input` | Build a tx that spends a UTxO using a reference script (vs. inline script). | P2W2 |
| `collateral-handling` | Build a tx that locks the right amount of collateral (in proportion to ex-units). | P2W2 |

## plutus-eval

Evaluating compiled Plutus scripts. P2W2 ships at least 5 vectors wrapped from [`IntersectMBO/plutus-conformance`](https://github.com/IntersectMBO/plutus-conformance) — we cite the upstream rather than reinvent the test vectors.

| Primitive | What it tests | Status |
|-----------|---------------|--------|
| `v3-builtin-coverage` | Each Plutus V3 built-in function evaluates correctly against pinned cost models. | P2W2 |
| `script-context-shape` | The `ScriptContext` value the validator sees matches the spec for the era. | P2W2 |
| `cost-model-loading` | SDKs load the era's cost model correctly and use it during evaluation. | P2W2 |

## governance

Conway-era governance actions: DRep votes, treasury withdrawals, hardfork actions, etc. **Explicitly deferred** — see [`../docs/design.md`](../docs/design.md). The slot is reserved here for when it lands.

| Primitive | What it tests | Status |
|-----------|---------------|--------|
| `drep-vote-tx` | Build a Conway DRep vote on a governance action. | Deferred |
| `treasury-withdrawal` | Build a treasury-withdrawal proposal tx. | Deferred |
| `hardfork-action` | Build/parse a hardfork-initiation governance action. | Deferred |
| `parameter-change-action` | Build/parse a protocol-parameter-change action. | Deferred |
| `committee-update` | Build/parse a constitutional-committee update action. | Deferred |
