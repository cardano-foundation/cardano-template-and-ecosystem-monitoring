# Storage Off-chain (Blaze)

Off-chain implementation for the Storage: Verifiable Audit Snapshots use case using Node.js, TypeScript, and the Blaze SDK.

## Features

- **Deterministic Snapshot Generation**: Seed-based PRNG for reproducible data
- **Canonical JSON Hashing**: Stable SHA-256 commitments
- **Merkle Tree Support**: Identify exactly which transaction was altered
- **CLI Interface**: Easy-to-use commands for all operations
- **Blaze SDK Integration**: Modern Cardano SDK for transactions

## Installation

```bash
npm install
```

## Build

```bash
npm run build
```

## Development

```bash
# Run CLI in development mode
npm run dev -- <command>

# Type checking
npm run typecheck

# Linting
npm run lint
```

## Testing

```bash
# Run tests once
npm test

# Watch mode
npm run test:watch
```

## CLI Usage

### Generate Snapshots

```bash
# Daily snapshot
npm run dev -- snapshot daily --date 2025-12-19 --seed 42

# Monthly snapshot  
npm run dev -- snapshot monthly --month 2025-12 --seed 42

# Output as JSON
npm run dev -- snapshot daily --date 2025-12-19 --seed 42 --output json

# Just the hash
npm run dev -- snapshot daily --date 2025-12-19 --seed 42 --output hash

# Save to file
npm run dev -- snapshot daily --date 2025-12-19 --seed 42 --save snapshot.json
```

### Publish to Blockchain

```bash
# Dry run (no transaction)
npm run dev -- publish daily --date 2025-12-19 --seed 42 --dry-run

# Actual publish
npm run dev -- publish daily --date 2025-12-19 --seed 42 --network preview
```

### Verify Against Blockchain

```bash
npm run dev -- verify daily --date 2025-12-19 --seed 42 --network preview
```

### Merkle Tree Operations

```bash
# Build Merkle Tree and show root hash
npm run dev -- merkle tree --date 2025-12-19 --seed 42

# Generate proof for a specific transaction
npm run dev -- merkle proof --date 2025-12-19 --seed 42 --index 7 --save proof.json

# Verify a proof
npm run dev -- merkle verify --proof proof.json

# Find differences between original data and a CSV/JSON file
# (Identifies EXACTLY which transactions were altered)
npm run dev -- merkle diff --date 2025-12-19 --seed 42 --file planilha.csv
```

## Project Structure

```
src/
├── cli.ts              # CLI entry point
├── index.ts            # Main exports
├── cli/
│   ├── snapshot.ts     # snapshot command
│   ├── publish.ts      # publish command
│   ├── verify.ts       # verify command
│   └── merkle.ts       # merkle tree commands
├── core/
│   ├── generator.ts    # Deterministic data generator
│   ├── hash.ts         # Canonicalizer and SHA-256
│   ├── merkle.ts       # Merkle Tree implementation
│   └── random.ts       # Seeded PRNG
├── blockchain/
│   ├── types.ts        # Adapter interface
│   └── blaze-adapter.ts # Blaze SDK implementation
└── types/
    └── snapshot.ts     # TypeScript types
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CARDANO_NETWORK` | `preview`, `preprod`, or `mainnet` |
| `WALLET_SEED` | 24-word mnemonic phrase |
| `WALLET_PRIVATE_KEY` | Alternative to seed |
| `BLOCKFROST_PROJECT_ID` | Blockfrost API key |

## How Deterministic Generation Works

The generator uses a seeded Mulberry32 PRNG:

1. Combine `snapshotId + seed + type` into a single seed
2. Use the seeded PRNG to generate all random values
3. Sort records deterministically by timestamp, then by ID

This ensures the same inputs always produce the exact same output.

## How Canonical Hashing Works

1. Create hashable data (excluding non-deterministic fields like `generatedAt`)
2. Sort all object keys lexicographically (recursive)
3. Serialize to compact JSON (no whitespace)
4. Compute SHA-256 hash

## How Merkle Tree Works

A Merkle Tree allows publishing a single hash (the root) while being able to prove and verify individual transactions:

```
                    ┌───────────┐
                    │   Root    │  ← Published on blockchain
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
        Txn 0   Txn 1           Txn 2   Txn 3
```

**Benefits:**
- **Single on-chain hash**: Cost-effective (~R$ 2-4 per snapshot)
- **Individual proofs**: Can prove any transaction is in the tree
- **Fraud detection**: Identifies EXACTLY which transaction was altered
- **Scalable**: Works with 10 or 10 million transactions

**Use case: Auditor finds tampered data**
```bash
$ npm run dev -- merkle diff -d 2025-12-19 -s 42 -f planilha_suspeita.csv

✗ DIFFERENCES FOUND: 1 transaction(s) altered

[7] Transaction MODIFIED
  ID: txn-a572b88b
  Changes:
    amount: 7166.41 → 12166.41
```

## License

Apache-2.0
