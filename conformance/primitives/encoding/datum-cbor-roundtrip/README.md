# `encoding/datum-cbor-roundtrip`

> Plutus-data → CBOR encoding (and the matching `blake2b_256` datum hash). The most fundamental encoding primitive in Cardano.

## What this is

Every datum stored on-chain is a `plutus_data` value (an integer, bytestring, list, map, or `Constr` of fields), encoded as CBOR per Cardano's canonical rules, and identified by the `blake2b_256` hash of that CBOR. This primitive tests that an SDK produces:

1. The **canonical CBOR** for a given `plutus_data` shape.
2. The **canonical hash** (`blake2b_256(cbor_hex)`) used everywhere the ledger references the datum.

If an SDK gets either wrong, every contract that reads or writes a datum through that SDK silently produces hashes that other SDKs (and the ledger) reject.

## Why it matters

Concrete failure modes this primitive catches:

- An SDK that wraps lone integers in an unnecessary `Constr 0`. Output looks like a valid datum to the SDK; ledger sees a different hash than the contract expected.
- An SDK that encodes lists as definite-length CBOR (`0x83 ...`) instead of indefinite-length (`0x9f ... 0xff`). Hash mismatches.
- An SDK that uses `Constr` tag 121 for alt 0 but tag 102 for alt 1 (instead of tag 122). Off-by-one in tag mapping.
- An SDK that outputs bytestrings as text strings (CBOR major type 3 instead of 2) for ASCII-printable inputs.

Each of these is silent: the SDK produces something that round-trips through itself but doesn't match the ledger or other SDKs. This primitive surfaces the mismatch in milliseconds.

## How it works (Cardano spec)

Cardano's canonical `plutus_data` encoding (per the [Plutus Core spec](https://plutus.readthedocs.io/en/latest/plutus-core-specification.html) and [`IntersectMBO/plutus`](https://github.com/IntersectMBO/plutus)):

| `plutus_data` shape | CBOR encoding |
|---|---|
| `Int n` | Standard CBOR integer (major type 0 for ≥0, major type 1 for negative) |
| `Bytes b` | CBOR major type 2 with length prefix; chunked into 64-byte segments if `len(b) > 64` |
| `List xs` | Indefinite-length list: `0x9f` + concatenated encodings of `xs` + `0xff` |
| `Map kv` | Indefinite-length map: `0xbf` + concatenated `k_i + v_i` pairs (sorted by `bytes_lex(encoded_k_i)`) + `0xff` |
| `Constr alt fs` (0 ≤ alt ≤ 6) | CBOR tag `121 + alt` + indefinite-length list of field encodings |
| `Constr alt fs` (7 ≤ alt ≤ 127) | CBOR tag `102` + indefinite-length list `[Int alt, indef-list of fields]` |

The hash is `blake2b_256(cbor_bytes)`, 32 bytes.

## Read the scenarios

- [`scenarios/conway/simple-int.json`](scenarios/conway/simple-int.json) — bare integer 42. The smallest case; catches SDKs that wrap lone integers in `Constr 0`.
- [`scenarios/conway/bare-bytes.json`](scenarios/conway/bare-bytes.json) — bare bytestring. Catches SDKs that emit text strings (major type 3) instead of bytes (major type 2).
- [`scenarios/conway/constr-with-bytes.json`](scenarios/conway/constr-with-bytes.json) — `Constr(0, [bytes, int, list])`. The most common datum shape; exercises tag-121 encoding and the indefinite-length list of fields.

## Try it yourself

```sh
# Run all scenarios across all SDK adapters
scripts/run-conformance.sh encoding/datum-cbor-roundtrip

# Run one scenario locally (any registered SDK)
conformance/adapters/meshjs/run-primitive.sh \
  conformance/primitives/encoding/datum-cbor-roundtrip/scenarios/conway/constr-with-bytes.json
```

You can also reproduce the expected values with the reference Python encoder embedded in [`conformance/scripts/compute-reference-cbor.py`](../../../scripts/compute-reference-cbor.py) (lands alongside the adapter implementations). The script produces the canonical CBOR + hash for any input shape, which is what the scenarios assert against.

## Current SDK support

Status appears in `matrix.json` under the primitive id. After CI runs, the dashboard will show pass-rate per SDK; today the local matrix.json is the source of truth.

## Spec references

- [Cardano CIP-19 — Cardano Addresses](https://cips.cardano.org/cip/CIP-19) (relevant for the related `encoding/address-bech32-roundtrip` primitive)
- [`IntersectMBO/plutus` — Data.hs](https://github.com/IntersectMBO/plutus/blob/master/plutus-core/plutus-core/src/PlutusCore/Data.hs) (the canonical Haskell reference)
- [RFC 8949 — Concise Binary Object Representation](https://www.rfc-editor.org/rfc/rfc8949.html) (the underlying CBOR spec)
