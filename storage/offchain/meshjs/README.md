# Storage - Mesh SDK Off-chain Implementation

## Description

This folder contains a command-line interface (CLI) to interact with the Aiken
`storage` validator using the Mesh SDK. It demonstrates:

- Building and submitting transactions to lock, update, and delete storage UTxOs
- Handling datum construction and serialization
- Managing wallet interactions and signatures
- Querying the blockchain for script UTxOs

## Framework and Tool Used

- **Framework**: [Mesh SDK](https://meshjs.dev/) v1.7+
- **Runtime**: Deno (TypeScript/JavaScript runtime)
- **Provider**: Blockfrost or Yaci devnet
- **Network**: Cardano Preprod testnet (default)

## Prerequisites

### 1. Install Deno

```bash
curl -fsSL https://deno.land/install.sh | sh
export PATH="$HOME/.deno/bin:$PATH"
deno --version  # Verify installation
```

### 2. Build the On-chain Validator

The off-chain code requires the compiled `plutus.json` blueprint:

```bash
cd ../../onchain/aiken
aiken build
cd ../../offchain/meshjs
```

Verify `plutus.json` exists:

```bash
ls ../../onchain/aiken/plutus.json
```

### 3. Configure Wallet

Set ONE of these environment variables:

**Option A: Use Root Key (Bech32)**

```bash
export ROOT_KEY_BECH32="xprv1..."
```

**Option B: Use Mnemonic (24 words)**

```bash
export MNEMONIC="word1 word2 word3 ... word24"
```

⚠️ **Security Warning**: Never use mainnet keys or commit keys to version
control!

### 4. Configure Provider (Optional)

**Option A: Use Blockfrost (Recommended)**

```bash
export BLOCKFROST_PROJECT_ID="preprod..."
export NETWORK_ID="0"  # 0 for preprod, 1 for mainnet
```

Get a free API key at [blockfrost.io](https://blockfrost.io)

**Option B: Use Yaci Devnet**

```bash
export YACI_URL="https://yaci-node.meshjs.dev/api/v1/"
export NETWORK_ID="0"
```

**Option C: Use Custom Node**

```bash
export YACI_URL="http://localhost:8080/api/v1/"
export NETWORK_ID="0"
```

## How to Run

### Type Check

Validate TypeScript code without running:

```bash
deno task check
```

### Lock (Create Storage UTxO)

Create a new storage UTxO with initial key-value data:

```bash
# Using UTF-8 strings
deno task lock -- --amount 2000000 --key-utf8 greeting --value-utf8 hello

# Using hex bytes
deno task lock -- --amount 3000000 --key-hex 48656c6c6f --value-hex 576f726c64
```

**Parameters**:

- `--amount`: Lovelace to lock (1 ADA = 1,000,000 lovelace, minimum ~1-2 ADA)
- `--key-utf8`: Storage key as UTF-8 string
- `--value-utf8`: Storage value as UTF-8 string
- `--key-hex`: Storage key as hex bytes (alternative to --key-utf8)
- `--value-hex`: Storage value as hex bytes (alternative to --value-utf8)

**Expected Output**:

```
Locking to storage contract...
Tx hash: 8a4b3f2c1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a
Storage UTxO created successfully!
```

### Set (Update Storage UTxO)

Update the value in an existing storage UTxO:

```bash
# Update value for a key
deno task set -- --key-utf8 greeting --value-utf8 "hello again"

# Update specific UTxO
deno task set -- --utxo "8a4b...#0" --key-utf8 mykey --value-utf8 "new value"
```

**Parameters**:

- `--key-utf8` / `--key-hex`: New key value
- `--value-utf8` / `--value-hex`: New value
- `--utxo` (optional): Specific UTxO to update (format: `txHash#index`)

**Expected Output**:

```
Updating storage UTxO...
Found UTxO: 8a4b3f2c1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a#0
Tx hash: 7c5a4b3e2f1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5
Storage updated successfully!
```

### Delete (Remove Storage UTxO)

Delete a storage UTxO and reclaim the locked ADA:

```bash
# Delete the first storage UTxO found
deno task delete

# Delete specific UTxO
deno task delete -- --utxo "8a4b...#0"
```

**Parameters**:

- `--utxo` (optional): Specific UTxO to delete (format: `txHash#index`)

**Expected Output**:

```
Deleting storage UTxO...
Found UTxO: 8a4b3f2c1d9e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a#0
Tx hash: 6b4a3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4
Storage deleted successfully! ADA reclaimed.
```

## How to Test

### Unit Tests

```bash
deno test --allow-read --allow-env
```

### Integration Testing

Test the full workflow on preprod testnet:

```bash
# 1. Type check
deno task check

# 2. Create storage
deno task lock -- --amount 2000000 --key-utf8 test --value-utf8 initial

# 3. Verify on Cardano Explorer
# Visit: https://preprod.cardanoscan.io/transaction/{txHash}

# 4. Update storage
deno task set -- --key-utf8 test --value-utf8 updated

# 5. Delete storage
deno task delete

# 6. Verify deletion on explorer
```

### Testing Different Data Types

```bash
# Strings
deno task lock -- --amount 2000000 --key-utf8 name --value-utf8 "John Doe"

# Numbers (as hex)
deno task lock -- --amount 2000000 --key-hex 636f756e74 --value-hex 00000001

# JSON (as UTF-8)
deno task lock -- --amount 2000000 --key-utf8 config --value-utf8 '{"debug":true}'

# Binary data (as hex)
deno task lock -- --amount 2000000 --key-hex deadbeef --value-hex cafebabe
```

## Architecture Notes

### Project Structure

```
storage/offchain/meshjs/
├── deno.json           # Deno configuration and tasks
├── main.ts             # CLI entry point and command handlers
├── src/
│   └── lib.ts          # Helper functions and transaction builders
└── README.md           # This file
```

### Key Components

1. **Provider Setup** (`src/lib.ts`)
   - Configures blockchain provider (Blockfrost or Yaci)
   - Handles network selection

2. **Wallet Initialization** (`src/lib.ts`)
   - Loads wallet from root key or mnemonic
   - Derives payment address

3. **Transaction Builders** (`src/lib.ts`)
   - `buildLockTx()`: Creates transaction to lock ADA with storage datum
   - `buildSetTx()`: Creates transaction to update storage with continuation
   - `buildDeleteTx()`: Creates transaction to delete storage without
     continuation

4. **CLI Commands** (`main.ts`)
   - Parses command-line arguments
   - Calls appropriate transaction builder
   - Signs and submits transactions

### Design Decisions

1. **Datum Construction**
   - Owner is derived from wallet payment address
   - Key/value support both UTF-8 and hex formats
   - Inline datums for better transparency

2. **UTxO Selection**
   - Automatically finds script UTxOs by address
   - Supports manual UTxO selection with `--utxo` flag
   - Uses first matching UTxO if not specified

3. **Error Handling**
   - Validates environment variables
   - Checks for blueprint existence
   - Provides clear error messages

4. **Transaction Construction**
   - Uses MeshTxBuilder for transaction assembly
   - Automatically handles collateral selection
   - Includes proper signature attachment

### Gas Costs (Approximate)

- **Lock**: ~0.2-0.3 ADA (transaction fee)
- **Set**: ~0.3-0.5 ADA (validator execution + transaction fee)
- **Delete**: ~0.3-0.5 ADA (validator execution + transaction fee)

_Note: Actual fees vary based on network congestion and transaction size_

## Troubleshooting

### "Blueprint not found" Error

```bash
# Build the Aiken validator first
cd ../../onchain/aiken && aiken build && cd -
```

### "Wallet not configured" Error

```bash
# Set either ROOT_KEY_BECH32 or MNEMONIC
export MNEMONIC="word1 word2 ... word24"
```

### "Insufficient funds" Error

- Fund your preprod wallet at
  [Cardano Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/)
- Ensure wallet has at least 5-10 ADA for testing

### "Script UTxO not found" Error

- Run `lock` command first to create a storage UTxO
- Or specify a specific UTxO with `--utxo` flag

### "Transaction failed" Error

- Check that you're using the correct network (preprod vs mainnet)
- Verify BLOCKFROST_PROJECT_ID matches network
- Check transaction on explorer for detailed error

## Limitations

1. **CLI Only**: No programmatic API or GUI
2. **Single Wallet**: One wallet per session
3. **No Indexing**: Must scan all script UTxOs
4. **No Batch Operations**: One operation per command
5. **Preprod Focus**: Optimized for testnet usage

## References

- [Mesh SDK Documentation](https://meshjs.dev/)
- [Deno Documentation](https://deno.land/manual)
- [Cardano Developer Portal](https://developers.cardano.org/)
- [Blockfrost API](https://docs.blockfrost.io/)

## Contributing

Part of the
[Cardano Foundation Holiday Season Challenge](https://cardanofoundation.org/blog/2025-holiday-season-challenge).
Contributions welcome:

- Add tests
- Improve error handling
- Add batch operations
- Create GUI interface
- Add more data formats
