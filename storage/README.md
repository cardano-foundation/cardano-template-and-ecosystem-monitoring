# Storage (Owner-controlled Datum State)

## Use Case Description

This use case demonstrates a **simple owner-controlled storage** pattern on Cardano, one of the most fundamental blockchain state management patterns. It shows how to:

- Store key-value data in a script UTxO datum
- Allow only the datum owner (identified by payment key hash) to update or delete the stored state
- Implement a state machine pattern with continuation UTxOs
- Handle two distinct state transitions: Update ("Set") and Delete

This pattern is commonly used for user-controlled data storage, configuration management, and any scenario requiring persistent on-chain state that only specific users can modify.

### Key Features

- **Owner Authorization**: Only the specified owner can modify the stored data
- **Key-Value Storage**: Flexible storage of arbitrary byte data
- **State Continuity**: Updates require creating a continuation output to maintain state
- **Clean Deletion**: Delete operation allows owner to close the state without continuation

## Implementations in This Folder

### On-chain

- **Framework**: [Aiken](https://aiken-lang.org/) v1.1.5+
- **Location**: `storage/onchain/aiken`
- **Purpose**: Validator that enforces owner authorization and state transition rules

### Off-chain

- **Framework**: [Mesh SDK](https://meshjs.dev/) with Deno/TypeScript
- **Location**: `storage/offchain/meshjs`
- **Purpose**: CLI tools to interact with the storage validator (lock, set, delete operations)

## How to Build, Run, and Test

### Prerequisites

1. **Install Aiken** (v1.1.5 or later):

   ```bash
   curl --proto '=https' --tlsv1.2 -LsSf https://install.aiken-lang.org | sh
   export PATH="$HOME/.aiken/bin:$PATH"
   aikup install v1.1.5
   ```

2. **Install Deno** (for off-chain):

   ```bash
   curl -fsSL https://deno.land/install.sh | sh
   ```

3. **Configure Wallet**: Set one of these environment variables:
   - `ROOT_KEY_BECH32`: MeshWallet root private key (bech32 format)
   - `MNEMONIC`: 24-word seed phrase (space-separated)

4. **Configure Provider** (optional):
   - `BLOCKFROST_PROJECT_ID`: Use Blockfrost provider
   - `YACI_URL`: Use custom Yaci node (defaults to https://yaci-node.meshjs.dev/api/v1/)
   - `NETWORK_ID`: Network ID (defaults to 0 for preprod)

### Build the On-chain Validator

```bash
cd storage/onchain/aiken
aiken check    # Type-check the validator
aiken build    # Build and generate plutus.json blueprint
```

**Expected Output**: `plutus.json` file in the `onchain/aiken` directory, containing the compiled Plutus script.

### Run the Off-chain Examples

```bash
cd storage/offchain/meshjs

# 1. Type-check the TypeScript code
deno task check

# 2. Lock (create initial storage UTxO with 2 ADA)
deno task lock -- --amount 2000000 --key-utf8 greeting --value-utf8 hello

# 3. Update the stored value
deno task set -- --key-utf8 greeting --value-utf8 "hello again"

# 4. Delete the storage UTxO and reclaim the locked ADA
deno task delete
```

### Test Commands

#### On-chain Testing

```bash
cd storage/onchain/aiken
aiken check    # Validates Aiken code and types
```

#### Off-chain Testing

```bash
cd storage/offchain/meshjs
deno task check    # Type-checks TypeScript code

# Interactive testing on preprod network:
deno task lock -- --amount 3000000 --key-hex 48656c6c6f --value-hex 576f726c64
deno task set -- --key-utf8 mykey --value-utf8 "new value"
deno task delete
```

## Architecture and Design Decisions

### Datum Structure

```aiken
type StorageDatum {
  owner: VerificationKeyHash,  // Who can modify this storage
  key: ByteArray,              // Storage key
  value: ByteArray             // Storage value
}
```

### Redeemer Actions

```aiken
type StorageRedeemer {
  Set { key: ByteArray, value: ByteArray }  // Update state with continuation
  Delete                                     // Remove state without continuation
}
```

### Validation Logic

1. **Owner Authorization**: All operations verify that `tx.extra_signatories` contains the datum's `owner` key hash
2. **Set Operation**:
   - Requires signature from owner
   - Must create exactly one continuation output to the same script address
   - Continuation output must have a datum (inline or hash)
3. **Delete Operation**:
   - Requires signature from owner
   - Must NOT create any outputs back to the script address

### Design Rationale

- **Signature-based Authorization**: Uses `extra_signatories` for simple, gas-efficient owner verification
- **Continuation Pattern**: Implements the standard eUTxO state machine pattern for mutable state
- **Flexible Data Types**: ByteArray for key/value allows arbitrary data storage (strings, JSON, binary)
- **Clean Deletion**: Separate Delete action prevents accidental loss of funds

## Notes and Limitations

### Current Limitations

- **Single Owner**: Only one owner per storage UTxO (no multi-sig support)
- **No Concurrency Control**: Multiple operations on the same UTxO require sequential processing
- **No Indexing**: Off-chain must scan all script UTxOs to find specific keys
- **Fixed Structure**: Datum structure cannot be updated without redeployment

### Production Considerations

For production use, consider:

- Adding reference scripts to reduce transaction costs
- Implementing proper indexing (database) for efficient key lookups
- Adding expiration/time-lock features
- Supporting multiple owners or delegation
- Adding value validation (e.g., schema enforcement)
- Implementing concurrency controls or optimistic locking

### Security Notes

- **Private Key Security**: Never commit mnemonics or private keys to version control
- **Network Selection**: Use preprod/preview for testing; mainnet requires careful validation
- **ADA Amounts**: Minimum UTxO requirements apply (~1 ADA minimum, varies by datum size)

## Useful Resources

- [Aiken Documentation](https://aiken-lang.org/)
- [Mesh SDK Documentation](https://meshjs.dev/)
- [Cardano eUTxO Model](https://docs.cardano.org/learn/eutxo-explainer/)
- [Cardano Foundation Developer Portal](https://developers.cardano.org/)

## Contributing

This implementation is part of the [Cardano Foundation Holiday Season Challenge](https://cardanofoundation.org/blog/2025-holiday-season-challenge). Contributions and alternative implementations using different frameworks are welcome!

For detailed implementation notes, see:

- [On-chain README](onchain/aiken/README.md)
- [Off-chain README](offchain/meshjs/README.md)
- [Study Notes](docs/STUDY.md)
