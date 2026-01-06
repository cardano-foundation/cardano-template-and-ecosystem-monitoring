# IoT Sentinel - Transformer Monitoring on Cardano

A proof-of-existence system for 3-phase distribution transformer monitoring data, storing sensor data hashes on the Cardano blockchain.

**Category**: Storage  
**Holiday Challenge 2025**  
**AI Assisted**: Developed with GitHub Copilot guidance

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
npm run dev             # Complete demo (ZK + blockchain)
```

## Demo Execution Guide

Run these commands to explore all features:

### 1. Complete Demo (Recommended)

```bash
cd storage/offchain/meshjs
npm run dev
```

This demonstrates the full flow:
- STEP 1: Device registration check (ZK keypair)
- STEP 2: Sensor data collection & signing with private key
- STEP 3: ZK proof verification using public key only
- STEP 4: Status analysis & local storage
- STEP 5: Blockchain submission

### 2. ZK Attack Simulations

```bash
# Fake device trying to inject data (will be rejected)
npm run zk:fake

# Man-in-the-middle tampering attack (will be rejected)
npm run zk:tamper
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
Creating ZK proof...
  Data hash: 4c9254dcf13654933cec86f8...
  Signature: bxU81vNKWvOExp1UYKmh9On7...

STEP 3: System - Verify ZK Proof
--------------------------------
[VERIFIED] ZK proof verified - data is from legitimate IoT device

STEP 4: Analyze Status & Save
-----------------------------
Status Code: 0 (SYSTEM_NORMAL)

STEP 5: Submit to Cardano Blockchain
-------------------------------------
[SUCCESS] Tx: 6a352e76ad6898a5f71429465373048...
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
npm run dev                    # Complete demo (ZK auth + blockchain)
npm run batch                  # Submit all pending records to blockchain
npm run add                    # Add random sensor reading
npm run add:overload           # Add overload scenario
npm run add:hightemp           # Add high temperature scenario
npm run add:phaseloss          # Add phase loss scenario
npm run verify                 # Verify from local registry
npm run verify -- --blockchain # Verify from blockchain (tamper-proof)
npm run verify -- --demo       # Tampering detection demo
```

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

Validator actions: Lock (store), Update (owner only), Spend (owner only)

## Deployed Contract (Preview)

- **Address**: `addr_test1wpdgzqgx8fn86rjvphs3wv20dm00h2u506xuzshjhprtkjsluh305`
- **Network**: Preview Testnet

## How Verification Works

1. Read sensor JSON from `data/readings/`
2. Recompute SHA-256 hash
3. Compare with hash on blockchain
4. Match = authentic, mismatch = tampered

The `--blockchain` flag fetches directly from chain, so even if local registry.json is modified, tampering is detected.

## Zero-Knowledge Device Authentication

The system includes ZK authentication to ensure data comes from legitimate IoT devices without revealing the secret key.

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

### Why "Zero-Knowledge"?

- System never knows the private key
- Yet can verify data came from legitimate device
- Device proves "I have the key" without revealing it

### ZK Commands

```bash
npm run zk:register  # Register new IoT device (generate keypair)
npm run zk:send      # Send authenticated data from device
npm run zk:fake      # Demo: Fake device attack (will fail)
npm run zk:tamper    # Demo: Data tampering attack (will fail)
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

- `lib/zk-auth.ts` - ZK authentication library
- `lib/secure-storage.ts` - Encrypted key storage & anti-replay
- `zk-demo.ts` - Demo script for all scenarios
- `data/devices.json` - Registered device public keys
- `data/device-keys.enc` - AES-256 encrypted private keys

## Security Features

- **Hash-based proof**: Only SHA-256 hash stored on-chain, not raw data
- **Owner-only operations**: Update/spend requires owner signature
- **Immutable timestamps**: Cannot be altered after submission
- **Off-chain privacy**: Sensitive data stays local
- **ZK device authentication**: Ed25519 signatures verify device identity
- **Encrypted key storage**: Private keys protected with AES-256-GCM
- **Anti-replay protection**: Nonce tracking prevents replay attacks
- **Re-registration protection**: Auth token required for key rotation
- **60-second timestamp window**: Limits proof validity period

## Resources

- [Aiken](https://aiken-lang.org)
- [MeshJS](https://meshjs.dev)
- [Blockfrost](https://blockfrost.io)

## License

Apache-2.0
