# Storage - Aiken On-chain Implementation

## Description

This Aiken validator implements an owner-controlled storage pattern for Cardano smart contracts. It demonstrates fundamental eUTxO state management concepts including:

- Owner-based authorization using signature verification
- State continuation pattern (UTxO chaining)
- Multiple redeemer actions (Set/Delete)
- Datum-based state storage

## Framework and Tool Used

- **Language**: Aiken v1.1.5+
- **Build Tool**: Aiken CLI
- **Output**: Plutus V2 validator (plutus.json blueprint)

## Validator Logic

### Datum Structure

```aiken
type StorageDatum {
  owner: VerificationKeyHash,  // Payment key hash of authorized user
  key: ByteArray,              // Storage key (arbitrary bytes)
  value: ByteArray             // Storage value (arbitrary bytes)
}
```

### Redeemer Structure

```aiken
type StorageRedeemer {
  Set { key: ByteArray, value: ByteArray }  // Update operation
  Delete                                     // Delete operation
}
```

### Spending Rules

The validator enforces these rules when spending a storage UTxO:

#### Common Rule (All Actions)

- Transaction must be signed by the `owner` from the datum
- Verified via `list.has(tx.extra_signatories, datum.owner)`

#### Set Action

- Must create exactly ONE continuation output to the same script address
- The continuation output must have a datum (inline or hashed)
- The continuation output continues the state machine

#### Delete Action

- Must NOT create any outputs back to the script address
- Allows owner to close the state and reclaim locked ADA

### Validation Logic Flow

```
Spend Storage UTxO
    |
    v
[Check Owner Signature]
    |
    v
[Check Redeemer Action]
    |
    +-- Set? --> [Verify continuation output exists with datum]
    |
    +-- Delete? --> [Verify no continuation output exists]
    |
    v
[Validation Success]
```

## How to Build

### Prerequisites

Install Aiken v1.1.5 or later:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://install.aiken-lang.org | sh
export PATH="$HOME/.aiken/bin:$PATH"
aikup install v1.1.5
aiken --version  # Should show v1.1.5 or higher
```

### Build Commands

From this directory (`storage/onchain/aiken`):

```bash
# Type-check the validator code
aiken check

# Build the validator and generate plutus.json blueprint
aiken build
```

### Expected Output

After `aiken build`, you should see:

```
    Compiling aiken-lang/stdlib 2.1.0 (/path/to/stdlib)
    Compiling storage 0.0.0 (/path/to/storage/onchain/aiken)
    Summary
        0 error, 0 warning(s)

    Generated blueprint: plutus.json
```

The `plutus.json` file contains the compiled Plutus Core script that the off-chain code will use.

## How to Test

### Type Checking

```bash
aiken check
```

This validates:

- Type correctness
- Function signatures
- Pattern matching completeness
- Module dependencies

### Unit Tests (if implemented)

```bash
aiken check -t  # Run with tests
```

### Manual Testing

Test the compiled validator using the off-chain Mesh scripts:

```bash
cd ../../offchain/meshjs
deno task lock -- --amount 2000000 --key-utf8 test --value-utf8 value
deno task set -- --key-utf8 test --value-utf8 newvalue
deno task delete
```

## Architecture Notes

### Design Decisions

1. **Signature-Based Authorization**
   - Uses `tx.extra_signatories` for owner verification
   - More efficient than using reference inputs or other patterns
   - Requires off-chain code to add the owner's signature

2. **ByteArray for Key/Value**
   - Maximum flexibility: supports strings, JSON, binary data
   - Off-chain handles encoding/decoding (UTF-8, hex, etc.)
   - No on-chain validation of data format

3. **Explicit Set/Delete Actions**
   - Clear separation of intent
   - Delete prevents accidental state continuation
   - Set enforces state continuity

4. **Continuation Pattern**
   - Standard eUTxO state machine implementation
   - New datum can have same or different owner/key/value
   - Off-chain code constructs the continuation output

### Security Considerations

- **Owner Key Security**: The owner's private key must be kept secure
- **Datum Size**: Large datums increase minimum ADA requirements
- **No Value Validation**: Validator doesn't validate key/value format or content
- **Single UTxO**: One storage UTxO per owner/key combination

### Gas Efficiency

- Uses minimal on-chain logic
- Signature verification is cheap
- No complex data structures or loops
- Typical transaction size: ~500-800 bytes

## Limitations

1. **No Multi-sig**: Single owner only (could be extended)
2. **No Expiration**: Storage persists indefinitely until deleted
3. **No Size Limits**: Datum size limited only by protocol parameters
4. **No Access Control**: Binary authorized/unauthorized, no read-only access

## File Structure

```
storage/onchain/aiken/
├── aiken.toml              # Project configuration
├── .gitignore              # Git ignore rules
├── README.md               # This file
├── validators/
│   └── storage.ak          # Main validator code
└── plutus.json             # Generated blueprint (after build)
```

## References

- [Aiken Language Documentation](https://aiken-lang.org/)
- [Aiken Standard Library](https://aiken-lang.github.io/stdlib/)
- [eUTxO Model Explainer](https://docs.cardano.org/learn/eutxo-explainer/)
- [Plutus Core Specification](https://plutus.cardano.intersectmbo.org/)

## Contributing

Part of the [Cardano Foundation Holiday Season Challenge](https://cardanofoundation.org/blog/2025-holiday-season-challenge). Alternative implementations and improvements welcome!
