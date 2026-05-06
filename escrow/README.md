# Escrow

<!-- CI_BADGE_BLOCK_BEGIN -->
[![Ecosystem tests · escrow](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml/badge.svg?branch=feat/ecosystem-monitoring-and-learning-enhancement)](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml)
<!-- CI_BADGE_BLOCK_END -->

> A trustless asset-exchange contract: an initiator and a recipient lock complementary assets at the script; the swap completes only when both have signed off. Either party can cancel before completion.

## What this is

A multi-party state machine implemented as a Cardano script. The contract goes through three observable states held in the script's datum:

1. **Initiation** — the initiator locks the assets they're willing to trade, and declares what assets they expect in return.
2. **Active escrow** — a recipient deposits the matching assets at the script. The datum now records both sides of the trade.
3. **Completion or cancellation** — both parties sign a transaction that pays each side what they were owed, OR one party cancels (returning their own assets to themselves).

This adds **state transitions in the datum** to the contract patterns covered so far. Every transition is enforced by the validator: you can't skip from Initiation straight to Completion, you can't change the agreed-upon assets after the recipient has deposited, and you can't take the other party's deposit without their signature.

## Why it matters

Real example: peer-to-peer asset swap. Alice holds NFT A and wants 100 USDM. Bob holds 100 USDM and wants NFT A. They could swap directly in a single transaction, but that requires both parties to be online simultaneously and to coordinate the tx construction perfectly. The escrow contract decouples them: Alice locks NFT A and declares "I want 100 USDM"; Bob (or anyone matching the offer) deposits 100 USDM at the script; both sign the completion tx asynchronously.

The pattern generalises to any "I'll trade X for Y when both parties commit and agree" scenario: real-estate transactions awaiting paperwork completion, fiat-on-ramps where the on-chain side waits for off-chain confirmation, deferred-settlement trades.

## How the onchain logic works

[`onchain/aiken/validators/escrow.ak`](onchain/aiken/validators/escrow.ak):

The datum carries the contract's state. There are two shapes:

```aiken
type EscrowDatum {
  Initiation { initiator: Address, expected: MValue }
  ActiveEscrow {
    initiator_address: Address, initiator_value: MValue,
    recipient_address: Address, recipient_value: MValue,
  }
}
```

And four redeemer variants:

```aiken
type EscrowRedeemer {
  RecipientDeposit { recipient_address: Address, recipient_value: MValue }
  CancelByInitiator
  CancelByRecipient
  CompleteEscrow
}
```

The validator enforces the transitions:

- **Recipient deposit** (`Initiation` → `ActiveEscrow`): the spend must produce a single output back to the script with the new `ActiveEscrow` datum, holding both the initiator's original value and the new recipient's value, all of it sent to the script.
- **Cancel by initiator** (any state → refund): only the initiator's signature is required. Funds return to the initiator.
- **Cancel by recipient** (`ActiveEscrow` → refund): only the recipient's signature is required. Funds return to the respective parties.
- **Complete escrow** (`ActiveEscrow` → done): both parties must sign. Output values must match the swap (initiator gets recipient's value, recipient gets initiator's value).

The validator uses helper functions (`vodka_*`) to inspect inputs, outputs, and signatories — see the file for the exact checks.

## How to use it offchain

Two offchain implementations exist: [`offchain/lucid-evolution/escrow.ts`](offchain/lucid-evolution/escrow.ts) and [`offchain/meshjs/escrow.ts`](offchain/meshjs/escrow.ts). The Lucid version is the most readable starting point because it has a CLI dispatch covering each transition.

CLI commands (Lucid):

| Command | Transition |
|---------|-----------|
| `prepare <count>` | Generates `<count>` test wallets and a local store for tracking escrow state. |
| `initiate <walletIndex>` | Locks the initiator's assets and declares what they want in return. Writes the new escrow id to the store. |
| `deposit <txHash> <walletIndex> <lovelace>` | Recipient deposits at the script. |
| `complete <txHash>` | Both parties sign the completion tx. |
| `cancel <txHash> <walletIndex>` | Either party cancels. |

The Mesh.js implementation is currently library-shape — a `MeshEscrowContract` class with the same set of operations as methods, intended to be imported and exercised from a driver. A runnable end-to-end driver lands in milestone P6.

## Try it yourself

You'll need [Yaci DevKit](https://devkit.yaci.xyz/) running locally:

```sh
yaci-devkit up --enable-yaci-store
```

Build the contract:

```sh
cd onchain/aiken
aiken check && aiken build
```

Then exercise the offchain flow (Lucid Evolution):

```sh
cd offchain/lucid-evolution
deno task prepare 5            # generate 5 test wallets
deno task initiate              # wallet 0 starts an escrow
# (note the txHash printed)
deno task deposit <txHash> 1 5000000   # wallet 1 deposits 5 ADA matching
deno task complete <txHash>            # both sign and complete
```

## What's tested in CI

The CI workflow ([`../.github/workflows/ecosystem-test.yml`](../.github/workflows/ecosystem-test.yml)) runs `aiken check && aiken build` and the offchain examples on every push and PR. Today the offchain examples are CLI-/library-shaped and don't run end-to-end without arguments; proper end-to-end integration tests for both Mesh.js and Lucid Evolution land in milestone P6.

## Variations to explore

- **Three-party escrow with arbitration.** Add an arbitrator pubkey hash to the datum; if the parties dispute, the arbitrator can sign a "judgment" tx that sends the funds however they decide.
- **Multi-asset bundle swaps.** Allow each side to lock a multi-asset value, not just a single one. The validator's `MValue` already supports this; the offchain orchestration is what changes.
- **Time-bounded escrow.** Add a deadline; force the escrow to either complete or cancel by then. After the deadline, anyone can trigger a refund.
