# Hash Timed Locked Contract (HTLC)

<!-- CI_BADGE_BLOCK_BEGIN -->
[![Ecosystem tests · htlc](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml/badge.svg?branch=feat/ecosystem-monitoring-and-learning-enhancement)](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml)
<!-- CI_BADGE_BLOCK_END -->

> The owner locks funds with a deadline and a hash. A guesser can claim before the deadline by revealing the matching pre-image; after the deadline, the owner reclaims.

## What this is

A two-actor, two-path contract:

- **Owner**: locks funds at the script. Knows a secret pre-image; locks the SHA-256 hash of it on chain.
- **Guesser**: anyone who can produce the secret. Has until the expiration to claim by submitting it as the redeemer.

Whichever path runs is chosen by the redeemer. The contract is a primitive for "release this if you know X, otherwise refund me after T."

## Why it matters

HTLCs are the cryptographic core of [atomic swaps](https://en.wikipedia.org/wiki/Atomic_swap), [Lightning Network channels](https://en.wikipedia.org/wiki/Lightning_Network), and any cross-chain or cross-party flow that says "I'll release my asset only if you simultaneously release yours." The same hash pre-image that unlocks one party's HTLC unlocks the other's; whoever claims first reveals the pre-image to the other, who then claims theirs. If neither claims, both refund after the timeout.

This pattern also implements simple "I'll pay you on delivery" without trusting a custodian: you give me a receipt with hash H, I lock the payment with H, on delivery you reveal the pre-image to claim the payment.

## How the onchain logic works

[`onchain/aiken/validators/htlc.ak`](onchain/aiken/validators/htlc.ak):

```aiken
pub type Htlc {
  GUESS { answer: ByteArray }
  WITHDRAW
}

validator htlc(secret: ByteArray, expiration: Int, owner: VerificationKeyHash) {
  spend(_datum, redeemer: Htlc, _utxo, tx: Transaction) {
    when redeemer is {
      GUESS { answer } ->
        and {
          valid_before(tx.validity_range, expiration),
          (sha2_256(answer) == secret),
        }
      WITHDRAW ->
        and {
          valid_after(tx.validity_range, expiration),
          key_signed(tx.extra_signatories, owner),
        }
    }
  }
}
```

- The script is **parameterised** by three values the owner picks at lock time: `secret` (the hash, not the pre-image), `expiration` (Unix-millis), and `owner` (the owner's pubkey hash).
- The redeemer is a sum type with two constructors:
  - `GUESS { answer }` — the spending tx supplies the pre-image. The validator hashes it and compares to `secret`. The transaction's validity range must end *before* the expiration (`valid_before`), so the guess must reach the chain in time.
  - `WITHDRAW` — only the owner can take this path. Validity range must start *after* expiration (`valid_after`).
- Mutually exclusive: a tx can only choose one redeemer. The validator never lets both run.

## How to use it offchain

Three offchain implementations exist; the **CCL-Java** version is the most direct match for the validator's shape (it constructs the redeemer as a `Constr` directly, mirroring the validator's `Htlc` type). Mesh.js and Lucid Evolution implementations follow the same logical flow with their own redeemer-construction idioms.

The flow in any SDK:

1. **Owner picks a secret** (pre-image) and computes its SHA-256 hash. Picks an `expiration` Unix-millis timestamp.
2. **Owner locks** `amount` ADA at the script address parameterised with `(hash, expiration, owner_pubkey_hash)`.
3. **Either**:
   - A guesser builds a tx whose redeemer is `GUESS { answer: <pre-image> }`, with validity-range end `< expiration`. Submits it.
   - The owner builds a tx whose redeemer is `WITHDRAW`, signed by themselves, with validity-range start `> expiration`. Submits it.

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

The CCL-Java offchain runner exercises the full lock + guess flow end-to-end:

```sh
cd offchain/ccl-java
jbang Htlc.java
```

(Mesh.js and Lucid Evolution variants are at [`offchain/meshjs/htlc.ts`](offchain/meshjs/htlc.ts) and [`offchain/lucid-evolution/htlc.ts`](offchain/lucid-evolution/htlc.ts).)

## What's tested in CI

The CI workflow ([`../.github/workflows/ecosystem-test.yml`](../.github/workflows/ecosystem-test.yml)) runs `aiken check && aiken build` and the offchain examples on every push and PR. Today the offchain TypeScript implementations are CLI-shaped and exit with usage on no-args; the CCL-Java variant runs end-to-end.

## Variations to explore

- **Multi-hop atomic swaps.** Lock funds with hash H on chain A; the counterparty locks their funds with the same hash H on chain B. The first to claim reveals the pre-image to the other. Build it locally with two HTLC contracts and the same secret.
- **Multi-recipient HTLC.** Allow any of N pubkeys to claim by replacing the single owner with a list. Useful for distributing payments contingent on a single proof.
- **Time-tiered payouts.** Different recipients claimable at different deadlines — extend the redeemer to encode which tier is being claimed and check the appropriate validity range.
