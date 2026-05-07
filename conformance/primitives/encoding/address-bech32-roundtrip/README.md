# `encoding/address-bech32-roundtrip`

> Cardano addresses → Bech32 strings (and back). Wallets, indexers, contract deployments, and SDKs all need to agree on this encoding for any address to be exchangeable.

## What this is

Cardano addresses are byte sequences with a structured header byte (encoding network + address type) followed by 28-byte credential hashes (payment key, script, stake key, or pointer). They're presented to users as **Bech32** strings — `addr_test1...`, `addr1...`, `stake_test1...`, `stake1...` — using a custom human-readable prefix per address kind.

This primitive tests the encoding direction: given the canonical bytes, an SDK must produce the canonical Bech32 string.

## Why it matters

Concrete failure modes this primitive catches:

- An SDK that uses **bech32m** (BIP-0350, used by Bitcoin Taproot) instead of plain **bech32** (BIP-0173). The two differ by a constant in the polymod; SDKs that grab a bech32 library off-the-shelf may default to bech32m and produce strings that look correct but checksum-fail at every other party's parser.
- An SDK that drops or duplicates the HRP (`addr_test`, `stake_test`, …).
- An SDK that uses the wrong header bits — e.g. encoding a stake address with payment-address bits, or vice versa.
- An SDK that mishandles the 8→5-bit conversion at the bech32 boundary (off-by-one padding).

Each is silent: the resulting string parses as bech32 but resolves to a different address than intended. Funds end up at an unintended location.

## How it works (Cardano spec)

Per [CIP-19](https://cips.cardano.org/cip/CIP-19):

| Address kind | Header byte | HRP (testnet) | HRP (mainnet) |
|---|---|---|---|
| Base (payment + stake key) | `0x00` / `0x10` (testnet `0`, mainnet `1`) | `addr_test` | `addr` |
| Enterprise (payment only) | `0x60` / `0x70` | `addr_test` | `addr` |
| Pointer | `0x40` / `0x50` | `addr_test` | `addr` |
| Stake key | `0xe0` / `0xf0` | `stake_test` | `stake` |
| Stake script | `0xe2` / `0xf2` | `stake_test` | `stake` |

The bech32 encoding is per [BIP-0173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki) (NOT bech32m / BIP-0350). The HRP is the prefix from the table above; the data is the address bytes converted from 8-bit to 5-bit with standard padding.

## Read the scenarios

- [`scenarios/conway/payment-address.json`](scenarios/conway/payment-address.json) — testnet enterprise address (header `0x60` + 28-byte payment hash). Catches `addr_test` HRP mismatches and bech32-vs-bech32m confusion.
- [`scenarios/conway/stake-address.json`](scenarios/conway/stake-address.json) — testnet stake address (header `0xe0` + 28-byte stake hash). Catches HRP confusion (`stake_test` vs `addr_test`) and header-bit mishandling.

## Try it yourself

```sh
scripts/run-conformance.sh encoding/address-bech32-roundtrip
```

The expected bech32 strings were computed using the standard BIP-0173 polymod implementation; the script that generated them is reproducible from the input bytes alone.

## Spec references

- [CIP-19 — Cardano Addresses](https://cips.cardano.org/cip/CIP-19) — header bytes and address types
- [BIP-0173 — Bech32](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki) — the bech32 polymod (NOT BIP-0350 bech32m)
