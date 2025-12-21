# Storage: Verifiable Audit Snapshots

A reference implementation of the **Storage** use case (#10) for the Cardano blockchain. This project demonstrates how to anchor cryptographic commitments (SHA-256 hashes) of off-chain data on-chain, enabling anyone to verify data integrity and proof of existence.

## Overview

**Pattern**: Off-chain processes → On-chain anchors → Verifier validates

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Generate Data  │────▶│  Anchor On-chain │────▶│     Verify      │
│  (Deterministic)│     │  (NFT + Datum)   │     │  (Re-hash +     │
│                 │     │                  │     │   Compare)      │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Key Features

- **Deterministic Generation**: Same inputs always produce the same output
- **Canonical Hashing**: Reproducible SHA-256 commitments
- **Merkle Tree**: Identify exactly which transaction was altered (fraud detection)
- **No-Overwrite**: Each snapshot can only be published once (one-shot NFT)
- **Immutable Storage**: On-chain records cannot be modified or deleted
- **Verifiable**: Anyone can regenerate data and verify against on-chain commitment

## Architecture

### Components

```
storage/
├── onchain/aiken/           # Smart contracts (Aiken)
│   ├── validators/
│   │   ├── mint.ak          # One-shot minting policy
│   │   └── storage.ak       # Immutable storage validator
│   └── lib/storage/
│       ├── types.ak         # Datum and redeemer types
│       └── utils.ak         # Helper functions
│
└── offchain/blaze/          # Off-chain CLI (Node/TypeScript)
    └── src/
        ├── core/            # Generator, hash, Merkle Tree
        ├── blockchain/      # Blaze SDK adapter
        ├── cli/             # CLI commands (snapshot, publish, verify, merkle)
        └── types/           # TypeScript types
```

### On-chain Data Structure

```
Registry UTxO
├── Value: min ADA + NFT marker (policyId + assetName)
└── Datum:
    ├── snapshot_id: ByteArray     # "2025-12-19" or "2025-12"
    ├── snapshot_type: SnapshotType # Daily | Monthly
    ├── commitment_hash: ByteArray  # 32 bytes (SHA-256)
    └── published_at: Int           # POSIX timestamp
```

### No-Overwrite Mechanism

The one-shot minting pattern guarantees uniqueness:

1. Minting policy is parametrized by a specific UTxO reference (`seed_utxo`)
2. To mint the NFT marker, this UTxO must be consumed
3. Since UTxOs can only be spent once, the NFT can only be minted once
4. Asset name = `sha256(snapshot_id)` ensures deterministic identification

## Prerequisites

- **Node.js** 20 LTS or later
- **Aiken** 1.1.9 or later (for on-chain contracts)
- **Blockfrost API key** (for Preview/Preprod networks)

## Quick Start

### 1. Build On-chain Contracts

```bash
cd storage/onchain/aiken
aiken build
```

### 2. Install Off-chain Dependencies

```bash
cd storage/offchain/blaze
npm install
```

### 3. Build Off-chain CLI

```bash
npm run build
```

### 4. Generate a Snapshot

```bash
# Generate daily snapshot
npm run dev -- snapshot daily --date 2025-12-19 --seed 42

# Generate monthly snapshot
npm run dev -- snapshot monthly --month 2025-12 --seed 42
```

### 5. Publish to Blockchain (requires wallet setup)

```bash
# Set environment variables
export CARDANO_NETWORK=preview
export WALLET_SEED="your 24 word mnemonic"
export BLOCKFROST_PROJECT_ID="your_project_id"

# Publish (dry run first)
npm run dev -- publish daily --date 2025-12-19 --seed 42 --dry-run

# Actual publish
npm run dev -- publish daily --date 2025-12-19 --seed 42
```

### 6. Verify Against Blockchain

```bash
npm run dev -- verify daily --date 2025-12-19 --seed 42 --network preview
```

## CLI Commands

### `snapshot daily`

Generate a daily snapshot for a specific date.

```bash
storage-cli snapshot daily --date <YYYY-MM-DD> --seed <number> [options]

Options:
  -d, --date <date>      Date in YYYY-MM-DD format (required)
  -s, --seed <seed>      Seed number for deterministic generation (required)
  -o, --output <format>  Output format: summary, json, hash (default: summary)
  --save <file>          Save full snapshot to file
```

### `snapshot monthly`

Generate a monthly snapshot (aggregation of all daily snapshots).

```bash
storage-cli snapshot monthly --month <YYYY-MM> --seed <number> [options]

Options:
  -m, --month <month>    Month in YYYY-MM format (required)
  -s, --seed <seed>      Seed number for deterministic generation (required)
  -o, --output <format>  Output format: summary, json, hash (default: summary)
  --save <file>          Save full snapshot to file
```

### `publish daily` / `publish monthly`

Publish a snapshot commitment to the blockchain.

```bash
storage-cli publish daily --date <YYYY-MM-DD> --seed <number> [options]

Options:
  -d, --date <date>      Date in YYYY-MM-DD format (required)
  -s, --seed <seed>      Seed number (required)
  -n, --network <net>    Network: preview, preprod, mainnet (default: preview)
  --dry-run              Show what would be published without submitting
```

### `verify daily` / `verify monthly`

Verify a snapshot commitment against on-chain data.

```bash
storage-cli verify daily --date <YYYY-MM-DD> --seed <number> [options]

Options:
  -d, --date <date>      Date in YYYY-MM-DD format (required)
  -s, --seed <seed>      Seed number (required)
  -n, --network <net>    Network: preview, preprod, mainnet (default: preview)
```

### `merkle tree`

Build a Merkle Tree and display the root hash.

```bash
storage-cli merkle tree --date <YYYY-MM-DD> --seed <number> [options]

Options:
  -d, --date <date>      Date in YYYY-MM-DD format (required)
  -s, --seed <seed>      Seed number (required)
  --show-leaves          Show all leaf hashes
  --save <file>          Save tree data to JSON file
```

### `merkle proof`

Generate a Merkle proof for a specific transaction.

```bash
storage-cli merkle proof --date <YYYY-MM-DD> --seed <number> --index <n> [options]

Options:
  -d, --date <date>      Date in YYYY-MM-DD format (required)
  -s, --seed <seed>      Seed number (required)
  -i, --index <index>    Transaction index (0-based, required)
  --save <file>          Save proof to JSON file
```

### `merkle diff`

Compare original data with a file and identify altered transactions.

```bash
storage-cli merkle diff --date <YYYY-MM-DD> --seed <number> --file <path> [options]

Options:
  -d, --date <date>      Original date (required)
  -s, --seed <seed>      Original seed (required)
  -f, --file <file>      CSV or JSON file to compare (required)
```

**Example output when fraud is detected:**
```
✗ DIFFERENCES FOUND: 1 transaction(s) altered

[7] Transaction MODIFIED
  ID: txn-a572b88b
  Original Hash: 6fa47cd5c01eb313...
  Current Hash:  1d8aa9a43c8c553a...
  Changes:
    amount: 7166.41 → 12166.41
```

## Testing

### Off-chain Tests

```bash
cd storage/offchain/blaze
npm test
```

### On-chain Tests

```bash
cd storage/onchain/aiken
aiken check
```

## How Canonical Hashing Works

To ensure reproducibility, we use canonical JSON serialization:

1. **Key Sorting**: Object keys are sorted lexicographically (recursive)
2. **Array Order**: Arrays maintain their original order (generator ensures determinism)
3. **Compact Format**: No whitespace, no formatting
4. **SHA-256**: Hash the canonical JSON string

Example:
```javascript
// Input (any key order)
{ z: 1, a: 2, nested: { b: 3, a: 4 } }

// Canonical JSON
{"a":2,"nested":{"a":4,"b":3},"z":1}

// SHA-256 Hash
sha256(canonical_json) → 64-char hex string
```

## How Merkle Tree Works

A Merkle Tree enables publishing a single hash while being able to identify exactly which transaction was altered:

```
                    ┌───────────┐
                    │   Root    │  ← Published on blockchain (single hash)
                    └─────┬─────┘
              ┌───────────┴───────────┐
              │                       │
        ┌─────┴─────┐           ┌─────┴─────┐
        │  Hash AB  │           │  Hash CD  │
        └─────┬─────┘           └─────┬─────┘
          ┌───┴───┐               ┌───┴───┐
          │       │               │       │
       Hash A   Hash B         Hash C   Hash D
          │       │               │       │
        Txn 0   Txn 1           Txn 2   Txn 3  ← Individual transactions
```

**Key Benefits:**

| Feature | Simple Hash | Merkle Tree |
|---------|-------------|-------------|
| On-chain cost | ~R$ 2-4 | ~R$ 2-4 (same) |
| Detect tampering | ✓ Yes | ✓ Yes |
| Identify which transaction | ✗ No | ✓ Yes |
| Prove individual transaction | ✗ No | ✓ Yes |
| Scalability | Good | Excellent |

**Workflow:**
1. Generate Merkle Tree from daily transactions
2. Publish only the **root hash** on blockchain
3. Store proofs locally (or regenerate on demand)
4. Auditor can verify any individual transaction
5. If verification fails, `merkle diff` shows exactly what changed

## Network Configuration

### Preview Testnet

- Get test ADA from [Cardano Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet)
- Get Blockfrost API key from [Blockfrost.io](https://blockfrost.io)

### Preprod Testnet

Same as Preview, select "preprod" network in Blockfrost dashboard.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `CARDANO_NETWORK` | Network: preview, preprod, mainnet | Yes |
| `WALLET_SEED` | 24-word mnemonic phrase | Yes* |
| `WALLET_PRIVATE_KEY` | Alternative to seed | Yes* |
| `BLOCKFROST_PROJECT_ID` | Blockfrost API key | Yes |

*Either `WALLET_SEED` or `WALLET_PRIVATE_KEY` is required.

## Security Considerations

- **Never commit wallet seeds or private keys**
- Use environment variables or secure secret management
- Test thoroughly on testnets before mainnet deployment
- The example dataset is synthetic; replace with your actual data

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

## License

Apache-2.0 - See [LICENSE](../LICENSE)

---

**Built for the [Cardano Foundation Holiday Season Challenge 2025](https://cardanofoundation.org/blog/2025-holiday-season-challenge)**