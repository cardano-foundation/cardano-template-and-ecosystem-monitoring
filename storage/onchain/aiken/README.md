# Storage: On-chain Contracts (Aiken)

This directory contains the on-chain smart contracts for the Storage: Verifiable Audit Snapshots use case.

## Prerequisites

Install Aiken (v1.1.9 or later):

```bash
# macOS (Homebrew)
brew install aiken-lang/tap/aiken

# Or using cargo
cargo install aiken --version 1.1.9

# Or download from releases
# https://github.com/aiken-lang/aiken/releases
```

## Build

```bash
cd storage/onchain/aiken
aiken build
```

## Test

```bash
aiken check
```

## Contracts

### Minting Policy (`validators/mint.ak`)

One-shot minting policy that ensures each snapshot can only be published once.

**Parameters:**
- `seed_utxo`: OutputReference that must be consumed (ensures uniqueness)
- `validator_hash`: Hash of the storage validator

**Rules:**
1. Must consume the seed UTxO
2. Must mint exactly 1 token
3. Asset name = sha256(snapshot_id)
4. Token must be sent to the storage validator
5. Output datum must match redeemer data

### Storage Validator (`validators/storage.ak`)

Immutable validator that holds snapshot commitment UTxOs.

**Behavior:**
- Always fails on spend (UTxOs are permanent)
- Datum contains: snapshot_id, snapshot_type, commitment_hash, published_at

## Types

Defined in `lib/storage/types.ak`:

```aiken
type SnapshotType {
  Daily
  Monthly
}

type RegistryDatum {
  snapshot_id: ByteArray,
  snapshot_type: SnapshotType,
  commitment_hash: ByteArray,
  published_at: Int,
}

type MintRedeemer {
  snapshot_id: ByteArray,
  snapshot_type: SnapshotType,
  commitment_hash: ByteArray,
}
```

## No-Overwrite Mechanism

The one-shot minting pattern guarantees that each snapshot can only be published once:

1. The minting policy is parametrized by a specific UTxO reference (`seed_utxo`)
2. To mint an NFT marker, this UTxO must be consumed
3. Since UTxOs can only be spent once, the NFT can only be minted once
4. The NFT's asset name is derived from the snapshot_id via sha256
5. Attempting to publish the same snapshot again would require the same seed UTxO, which no longer exists

This provides cryptographic proof that a commitment was anchored at a specific point in time and cannot be altered.
