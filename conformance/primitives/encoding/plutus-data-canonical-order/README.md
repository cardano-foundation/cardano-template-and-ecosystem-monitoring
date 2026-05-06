# `encoding/plutus-data-canonical-order`

> Map keys inside Plutus-data CBOR must be sorted by the lexicographic ordering of the keys' encoded bytes. SDKs that emit unsorted (or differently-sorted) maps produce datums whose hash won't match the canonical form.

## What this is

A targeted version of `datum-cbor-roundtrip` focused on a single subtle rule: **the canonical CBOR encoding of a `plutus_data` Map sorts keys by the lexicographic ordering of their CBOR-encoded bytes** (per [RFC 8949 §4.2.1](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2.1)).

Two scenarios:

- One where the input keys are already in canonical order. The SDK should emit them as-is.
- One where the input keys are in REVERSE canonical order. The SDK must sort them before emitting CBOR.

Both produce the *same* expected CBOR (the canonical form is unique). An SDK that emits unsorted keys will fail the second scenario.

## Why it matters

The datum hash is computed over the encoded CBOR bytes. Two CBORs that differ only in map-key order produce different hashes. If an SDK emits a map in the order it was constructed (instead of canonical order), the resulting datum hash won't match the on-chain canonical form, and any contract that compares datum hashes will reject the spend.

Concrete failure mode: a wallet builds a datum from a JavaScript object whose keys are in insertion order. The map is `{ "b": ..., "a": ... }`. The wallet hashes the encoded CBOR. The on-chain validator computes the hash over the same logical datum — but the validator (or another SDK that produced the datum first) used canonical order: `{ "a": ..., "b": ... }`. Hashes don't match. Spend fails. The wallet developer spends a day diffing CBOR bytes.

## How it works (Cardano spec)

The Cardano canonical-order rule for plutus_data Map keys:

1. Encode each key with the same canonical plutus_data CBOR rules (recursively).
2. Sort the (key, value) pairs lexicographically by the encoded-key byte sequences.
3. Emit the indefinite-length map in that order: `0xbf` + sorted pairs + `0xff`.

Bytestring keys are compared byte-by-byte; integer keys are compared by their encoded form (which makes small positive integers smaller than large positive integers smaller than negative integers — be careful). Mixed-type keys are unusual but legal.

## Read the scenarios

- [`scenarios/conway/map-already-sorted.json`](scenarios/conway/map-already-sorted.json) — input keys 0x01, 0x02 (already in order). Baseline.
- [`scenarios/conway/map-needs-sorting.json`](scenarios/conway/map-needs-sorting.json) — input keys 0x02, 0x01 (reversed). Forces the SDK to sort. Expected CBOR is **identical** to the previous scenario.

If both pass, the SDK respects canonical order. If the second fails but the first passes, the SDK is preserving insertion order — a bug.

## Try it yourself

```sh
scripts/run-conformance.sh encoding/plutus-data-canonical-order
```

## Spec references

- [`IntersectMBO/plutus` — Data.hs](https://github.com/IntersectMBO/plutus/blob/master/plutus-core/plutus-core/src/PlutusCore/Data.hs) (the canonical Haskell reference; map encoding sorts by encoded-key bytes)
- [RFC 8949 §4.2.1](https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2.1) (general CBOR canonical-order rule)
