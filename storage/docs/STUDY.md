# Study Notes: Storage (Aiken + Mesh)

## 1) What is being demonstrated?
This "Storage" example is a minimal but meaningful eUTxO state machine pattern:

- The state is encoded as a datum on a script-controlled UTxO.
- Updating the state is done by:
  1) Spending the old script UTxO (requires owner signature), and
  2) Creating a new script output (continuation) carrying the new datum.

This is the canonical way to model mutable state on Cardano.

## 2) Design choices

### Owner authorization
On-chain checks `tx.extra_signatories` includes the stored `owner` key hash.

### Two actions
- `Set`: must continue the state by creating at least one output back to the same script address **with a datum**.
- `Delete`: must not create any output back to the script address.

### Datum contents
Datum = `(owner, key, value)` where `key` and `value` are bytes.
Off-chain supports both UTF-8 inputs and raw hex inputs.

## 3) Reproducibility tips
- `deno task check` works without the blueprint, but `lock/set/delete` require `plutus.json`.

## 4) Limitations
This is intentionally minimal. A production system could add indexing, concurrency controls, reference scripts, and stronger invariants.
