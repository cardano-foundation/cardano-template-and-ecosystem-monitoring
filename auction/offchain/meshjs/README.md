# Auction Offchain (MeshJS + Deno)

This module provides a lightweight MeshJS offchain client for the Auction contract with three flows:
- startAuction: lock the NFT and publish an inline datum
- placeBid: consume and re-create a continuing output with increased bid
- endAuction: settle the auction (NFT to highest bidder, lovelace to seller)

## Prerequisites
- Deno 1.41+ (Node/NPM compatibility for `npm:` specifiers)
- Aiken-generated blueprints present at:
  - `./aiken-workspace-v1/plutus.json`
  - `./aiken-workspace-v2/plutus.json`
- A `MeshTxInitiator` helper (same as used by `escrow/` and `vesting/` flows) located at `../common` relative to this folder. If your helper lives elsewhere, update the import in `auction.ts` accordingly.

## Install Deno (Windows)
```powershell
winget install -e --id DenoLand.Deno
# or
iwr https://deno.land/install.ps1 -useb | iex
```
Verify:
```powershell
deno --version
```

## Dependencies
This folder includes `deno.json` that maps Mesh imports:
- `@meshsdk/core@1.8.14`
- `@meshsdk/core-cst@1.9.0-beta.20`
- `@meshsdk/common@1.9.0-beta.20`

Deno will fetch them automatically on first run.

Pre-cache and type-check:
```powershell
# from auction/offchain/meshjs
deno cache auction.ts
deno check auction.ts
```

## Quick Start Example
```ts
// demo.ts (for experimentation only)
import { MeshAuctionContract } from "./auction.ts";

// You must provide your own MeshTxInitiator-compatible inputs.
// Typically includes: mesh builder instance, networkId (0 preprod, 1 mainnet),
// version (1 or 2 for script version), and languageVersion.
const contract = new MeshAuctionContract({
  mesh: /* your mesh tx builder */ null as any,
  networkId: 0,          // 0: preprod, 1: mainnet
  version: 1,            // Aiken blueprint set to use (v1 or v2)
  languageVersion: "V2", // depends on your script
});

// Start an auction by locking an NFT at the script address
// Replace with a real asset unit and quantities.
const nftUnit = "<policyId>.<assetName>"; // e.g., "abcd...ef.4e4654" for "NFT"
const txHex = await contract.startAuction([
  { unit: nftUnit, quantity: "1" },
], Date.now() + 3 * 24 * 60 * 60 * 1000, 0n);
console.log("Start Auction Tx Hex:", txHex);
```
Run the demo (it will at least fetch dependencies and type-check; sending requires wallet integration):
```powershell
deno run -A demo.ts
```

Note: Calls like `getWalletInfoForTx()` expect a wallet provider (e.g., CIP-30 in a browser-based dApp). For CLI-only experiments, you can mock or stub `mesh` and related fields, but you cannot submit real transactions without a wallet and network backend.

## Handy Tasks
You can also use Deno tasks (see `deno.json` here):
```powershell
deno task cache
deno task check
```

## Troubleshooting
- Missing `../common`: Ensure your shared `MeshTxInitiator` helper exists or update the import path in `auction.ts`.
- Blueprint not found: Make sure Aiken outputs are copied to `aiken-workspace-v1`/`-v2` folders.
- Type errors on Mesh imports: Ensure you are in this folder when running Deno so `deno.json` is picked up.
