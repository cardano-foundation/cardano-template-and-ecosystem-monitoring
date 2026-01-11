# Decentralized Identity (Lucid Evolution)

This off-chain workflow drives the DID state machine defined in `onchain/aiken`. It creates an identity UTxO, adds and removes delegates, and transfers ownership using Lucid Evolution on Preprod.

## Prerequisites

- Deno 2.0+
- Aiken (to build `plutus.json`)
- A funded Preprod wallet

## Setup

```sh
cd decentralized-identity/onchain/aiken
aiken build
```

```sh
cd ../../offchain/lucid-evolution
# Fix missing libsodium-sumo.mjs file (workaround for Deno npm compatibility)
./fix-libsodium.sh
deno run -A did.ts prepare
```

Fund the printed owner address with tADA before continuing.

## Run

```sh
# Create the identity UTxO
deno run -A did.ts init 3000000

# Add a delegate (expiry in ms since epoch)
deno run -A did.ts add-delegate <txHash> 0 1893456000000

# Remove the delegate
deno run -A did.ts remove-delegate <txHash> 0

# Transfer ownership to a new address
# (replace with a bech32 payment address)
deno run -A did.ts transfer-owner <txHash> 0 addr_test1...

# View the current datum
deno run -A did.ts show <txHash> 0
```

## Notes

- The owner must sign all updates.
- Delegates are stored as payment key hashes with an expiry timestamp.
- Transactions preserve the locked value and always recreate a single continuing output.
