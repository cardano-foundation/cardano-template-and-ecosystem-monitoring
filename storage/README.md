# IoT Sentinel - Transformer Monitoring on Cardano

A proof-of-existence system for 3-phase distribution transformer monitoring data, storing sensor data hashes on the Cardano blockchain.

**Category**: Storage  
**Holiday Challenge 2025**

## What It Does

Electric utilities need tamper-proof records of transformer data for audits, compliance, and incident investigations. This system:

1. Collects sensor readings (voltage, current, temperature)
2. Analyzes status and computes SHA-256 hash
3. Stores hash on Cardano blockchain
4. Provides verification to detect any data tampering

The actual data stays off-chain (privacy), only the hash goes on-chain (proof).

## Quick Start

### Build Contract

```bash
cd storage/onchain/aiken
aiken check
aiken build

# Get the contract address
aiken blueprint address . -v storage
# Output: addr_test1wrfaus9yayyr76ypyhyuzgu62370a2numc0tr2kfutezedqeh2vfg
```

### Setup Off-chain

```bash
cd storage/offchain/meshjs
npm install
cp .env.example .env
# Edit .env with your Blockfrost key and wallet mnemonic
```

### Run

```bash
npm run dev             # Complete demo (device auth + blockchain)
```

> **Note**: The `data/` folder is auto-generated on first run. Device registration, sensor readings, and all necessary files are created automatically when you execute the demo.

## Demo Execution Guide

Run these commands to explore all features:

### 1. Complete Demo (Recommended)

```bash
cd storage/offchain/meshjs
npm run dev
```

This demonstrates the full flow:
- STEP 1: Device registration check (Ed25519 keypair)
- STEP 2: Sensor data collection & signing with private key
- STEP 3: Digital signature verification using public key only
- STEP 4: Status analysis & local storage
- STEP 5: Blockchain submission

### 2. Security Attack Simulations

```bash
# Fake device trying to inject data (will be rejected)
npm run auth:fake

# Man-in-the-middle tampering attack (will be rejected)
npm run auth:tamper
```

### 3. Blockchain Verification

```bash
# Verify all data from blockchain (tamper-proof)
npm run verify -- --blockchain

# Demo: Manually tamper a JSON file, then verify to see detection
```

### 4. Generate Different Scenarios

```bash
npm run add:overload    # Overload condition
npm run add:hightemp    # High temperature
npm run add:phaseloss   # Phase loss (critical)
npm run batch           # Submit all pending to blockchain
```

### Expected Output

When running `npm run dev`, you should see:
```
STEP 1: Device Registration Check
----------------------------------
Device TRAFO-SINJAI-01 already registered

STEP 2: IoT Device - Generate & Sign Data
------------------------------------------
Creating digital signature...
  Data hash: 4c9254dcf13654933cec86f8...
  Signature: bxU81vNKWvOExp1UYKmh9On7...

STEP 3: System - Verify Digital Signature
-----------------------------------------
[VERIFIED] Signature verified - data is from legitimate IoT device

STEP 4: Analyze Status & Save
-----------------------------
Status Code: 0 (SYSTEM_NORMAL)

STEP 5: Submit to Cardano Blockchain
-------------------------------------
♻️  UTXO Recycling Mode
  Spending old UTxO: 42fcca80f698d6c3...
  Recycling deposit: 2 ADA
  Net cost: ~0.3 ADA (fee only)

[SUCCESS] Tx: 3a922962a92f27865abf1acfb86664a...
```

## Sensor Data Example

```json
{
  "device_id": "TRAFO-SINJAI-01",
  "phase_voltage": { "R": 220.5, "S": 219.0, "T": 221.2 },
  "phase_current": { "R": 50.0, "S": 49.5, "T": 51.0 },
  "temperature": 65,
  "inom_setting": 100,
  "timestamp": 1736150400
}
```

## Commands

```bash
npm run dev                    # Complete demo (device auth + blockchain)
npm run batch                  # Submit all pending records to blockchain
npm run add                    # Add random sensor reading
npm run add:overload           # Add overload scenario
npm run add:hightemp           # Add high temperature scenario
npm run add:phaseloss          # Add phase loss scenario
npm run verify                 # Verify from local registry
npm run verify -- --blockchain # Verify from blockchain (tamper-proof)
npm run verify -- --demo       # Tampering detection demo
```

## UTXO Recycling for Cost Efficiency

This system implements **UTXO Recycling** to minimize transaction costs on Cardano blockchain.

### How It Works

**Without Recycling (Traditional approach):**
- Every transaction: Fee (~0.2 ADA) + Deposit (2 ADA) = **~2.2 ADA**
- 100 transactions = **220 ADA**

**With Recycling (Our implementation):**
- First transaction: Fee + Deposit = **~2.2 ADA**
- Subsequent transactions: Fee only (deposit recycled) = **~0.3 ADA**
- 100 transactions = 2.2 + (99 × 0.3) = **~31.9 ADA**

**Savings: ~86% (188 ADA saved per 100 transactions)**

### How Recycling Works

1. **Transaction 1**: Lock 2 ADA deposit at script address
2. **Transaction 2**: Spend UTxO from Tx1 (reclaim 2 ADA) + Lock new data (reuse 2 ADA)
3. **Transaction 3**: Spend UTxO from Tx2 (reclaim 2 ADA) + Lock new data (reuse 2 ADA)
4. And so on...

Each transaction (after the first) only pays the transaction fee, while the deposit keeps being recycled.

### In Production

For a monitoring system sending data every 5 minutes:
- **Per day**: 1 first-time (2.2 ADA) + 287 recycled (0.3 ADA each) = ~88 ADA
- **Per month**: ~2,594 ADA
- **Without recycling**: ~19,008 ADA/month
- **Monthly savings: ~16,414 ADA** (86%)

## Status Codes

```
0  SYSTEM_NORMAL         All parameters OK
1  CRITICAL_OVERLOAD     Current > 100% Inom
2  WARNING_HIGH_LOAD     Current > 80% Inom
3  ALERT_UNDER_VOLTAGE   Voltage < 200V
4  ALERT_OVER_VOLTAGE    Voltage > 240V
5  WARNING_LOAD_IMBALANCE Phase difference > 20%
6  CRITICAL_HIGH_TEMP    Temperature > 80C
7  CRITICAL_PHASE_LOSS   Phase voltage at zero
8  INFO_ZERO_LOAD        Transformer idle
```

## On-chain Structure

```aiken
type IoTRecord {
  owner: VerificationKeyHash,
  device_id: ByteArray,
  timestamp: Int,
  data_hash: ByteArray,
  status_code: Int,
}
```

Validator actions: Lock (store), Update (owner only), Spend (owner only for UTXO recycling)

## Deployed Contract (Preview)

- **Current Address** (with UTXO Recycling): `addr_test1wrfaus9yayyr76ypyhyuzgu62370a2numc0tr2kfutezedqeh2vfg`
- **Legacy Address** (without recycling): `addr_test1wpdgzqgx8fn86rjvphs3wv20dm00h2u506xuzshjhprtkjsluh305`
- **Network**: Preview Testnet
- **Script Hash**: `d3de40a4e9083f688125c9c1239a547cfeaa7cde1eb1aac9e2f22cb4`

> **Note**: The current address is generated using Aiken CLI (`aiken blueprint address`) which produces the correct script hash for Plutus V3. The legacy address was generated by MeshJS which had a bug in address generation.

## How Verification Works

1. Read sensor JSON from `data/readings/`
2. Recompute SHA-256 hash
3. Compare with hash on blockchain
4. Match = authentic, mismatch = tampered

The `--blockchain` flag fetches directly from chain, so even if local registry.json is modified, tampering is detected.

## Cryptographic Device Authentication

The system uses Ed25519 digital signatures to ensure data comes from legitimate IoT devices without exposing the private key (zero-exposure principle).

### How It Works

1. **Device Registration**: Each IoT device generates an Ed25519 keypair
   - Private key stays on device (never shared)
   - Public key registered in system

2. **Data Signing**: When sending data, device:
   - Hashes the sensor data
   - Signs hash + nonce + timestamp with private key
   - Sends data + signature to system

3. **Verification**: System verifies using public key only
   - Checks device is registered
   - Verifies signature matches data
   - Accepts only if valid

### Why "Zero-Exposure"?

- Private key never leaves the IoT device
- System verifies using public key only
- Device proves authenticity without exposing secrets

### Device Auth Commands

```bash
npm run auth:register  # Register new IoT device (generate keypair)
npm run auth:send      # Send authenticated data from device
npm run auth:fake      # Demo: Fake device attack (will fail)
npm run auth:tamper    # Demo: Data tampering attack (will fail)
```

### Attack Scenarios

**Fake Device Attack**: Attacker tries to inject fake data
- Without private key, cannot create valid signature
- System rejects: "Invalid signature - not from registered device"

**Man-in-the-Middle Attack**: Attacker modifies data in transit
- Original signature was for original data
- Modified data produces different hash
- System rejects: "Data hash mismatch - data may be tampered"

### Files

- `lib/device-auth.ts` - Device authentication library
- `lib/secure-storage.ts` - Encrypted key storage & anti-replay
- `lib/interaction.ts` - Blockchain interaction with UTXO recycling
- `auth-demo.ts` - Demo script for all scenarios
- `data/devices.json` - Registered device public keys
- `data/device-keys.enc` - AES-256 encrypted private keys

## Technical Implementation

### UTXO Recycling Implementation

The system implements efficient UTXO recycling in `lib/interaction.ts`:

**Key Functions:**
- `findOwnedUtxo()` - Locates recyclable UTxOs owned by the wallet
- `lockDataWithRecycling()` - Spends old UTxO + locks new data in single transaction
- Script hash validation ensures compatibility between UTxO versions

**Transaction Flow:**
```typescript
// First transaction (no UTxO to recycle)
txBuilder
  .txOut(scriptAddress, [{ unit: 'lovelace', quantity: '2000000' }])
  .txOutInlineDatumValue(datum)
  .complete()

// Subsequent transactions (with recycling)
txBuilder
  .spendingPlutusScriptV3()
  .txIn(oldUtxo.input.txHash, oldUtxo.input.outputIndex)
  .txInInlineDatumPresent()
  .txInRedeemerValue(REDEEMER_SPEND)
  .txInScript(scriptCode)
  .txOut(scriptAddress, [{ unit: 'lovelace', quantity: '2000000' }])
  .txOutInlineDatumValue(newDatum)
  .complete()
```

**Requirements:**
1. Script hash must match between lock and spend operations
2. Collateral UTxO (≥5 ADA) required for Plutus script execution
3. Owner signature required (specified in datum)

### Address Generation

**Correct Method (Aiken CLI):**
```bash
aiken blueprint address . -v storage
# Output: addr_test1wrfaus9yayyr76ypyhyuzgu62370a2numc0tr2kfutezedqeh2vfg
```

**Issue with MeshJS:**
MeshJS `serializePlutusScript()` generates incorrect address for Plutus V3 scripts. The workaround is to use the hardcoded address from Aiken CLI in `initContract()`.

## Security Features

- **Hash-based proof**: Only SHA-256 hash stored on-chain, not raw data
- **Owner-only operations**: Update/spend requires owner signature
- **Immutable timestamps**: Cannot be altered after submission
- **Off-chain privacy**: Sensitive data stays local
- **Device authentication**: Ed25519 signatures verify device identity
- **Encrypted key storage**: Private keys protected with AES-256-GCM
- **Anti-replay protection**: Nonce tracking prevents replay attacks
- **Re-registration protection**: Auth token required for key rotation
- **60-second timestamp window**: Limits proof validity period
- **UTXO recycling**: Cost-efficient storage with 86% savings after first transaction

## Cost Analysis

### Traditional Approach (Without Recycling)
- Transaction fee: ~0.2 ADA
- MinUTxO deposit: 2.0 ADA (locked per record)
- **Cost per record: ~2.2 ADA**

### With UTXO Recycling
- First record: ~2.2 ADA (fee + deposit)
- Subsequent records: ~0.3 ADA (fee only)
- **Average cost (100 records): 0.32 ADA/record**

### Real-world Savings
**Scenario**: Monitoring system with 5-minute intervals

| Period | Without Recycling | With Recycling | Savings |
|--------|------------------|----------------|---------|
| 1 Day  | 633.6 ADA | 88.3 ADA | 86% |
| 1 Week | 4,435 ADA | 618 ADA | 86% |
| 1 Month | 19,008 ADA | 2,594 ADA | 86% |
| 1 Year | 228,096 ADA | 31,127 ADA | 86% |

**Annual savings: ~197,000 ADA**

## Resources

- [Aiken](https://aiken-lang.org)
- [MeshJS](https://meshjs.dev)
- [Blockfrost](https://blockfrost.io)

## AI Assisted

This project was developed with the assistance of AI coding tools.

## License

Apache-2.0
