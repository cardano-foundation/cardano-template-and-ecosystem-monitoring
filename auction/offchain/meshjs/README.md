# Auction MeshJS Off‑Chain

TypeScript/ESM off‑chain helpers for the Aiken auction validator using MeshJS. Includes a lightweight Vitest suite with mocks to avoid WASM/CSL requirements during local testing.

## Project Structure

- src/index.ts — `MeshAuctionContract` with `initiateAuction`, `placeBid`, `endAuction` and `auctionDatum` helper.
- src/common.ts — shared `MeshTxInitiator` utilities for wallet/script lookup.
- src/index.test.ts — Vitest tests with mocked Mesh SDK primitives to keep tests deterministic and WASM-free.
- package.json / tsconfig.json — ESM (module: nodenext) config for MeshJS usage.

## Prerequisites

- Node.js 18+ (ESM/Nodenext).
- pnpm or npm (examples below use npm).

## Install & Test

```bash
npm install
npm test
```

## Using the Contract Helpers

```ts
import { MeshAuctionContract } from './src/index.js';

const contract = new MeshAuctionContract({
  mesh, // MeshTxBuilder instance
  wallet, // CIP-30 wallet adapter
  fetcher, // UTxO fetcher (matches Mesh fetcher interface)
  networkId: 0, // 0=testnet/preprod, 1=mainnet
});

// Start an auction
await contract.initiateAuction(
  { unit: '<policy><assetName>', quantity: '1' },
  Math.floor(Date.now() / 1000) + 3600, // expiration (POSIX seconds)
  10_000_000 // starting bid in lovelace
);

// Place a bid
await contract.placeBid(auctionUtxo, 15_000_000);

// End auction
await contract.endAuction(auctionUtxo);
```

## Implementation Notes

- Datum fields use `builtinByteString`/`integer`; pass hex strings for pubkey hashes and asset policy/name.
- The on-chain script is parameterless; `applyParamsToScript` wraps the Aiken compiled code from `onchain/aiken/plutus.json`.
- Tests mock `deserializeAddress`/`deserializeDatum` and use a mock tx builder to avoid WASM “unreachable” errors; production usage should rely on real Mesh primitives.
- `networkId` controls address encoding when constructing payment outputs in `endAuction`.

## Troubleshooting

- ESM errors: ensure `type` is `module` in package.json and `module` is `nodenext` in tsconfig.
- CSL/WASM runtime errors during tests: keep the provided Vitest mocks, or run tests in a Node environment with CSL support.
