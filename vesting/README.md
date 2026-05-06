# Vesting

<!-- CI_BADGE_BLOCK_BEGIN -->
[![Ecosystem tests · vesting](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml/badge.svg?branch=feat/ecosystem-monitoring-and-learning-enhancement)](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml)
<!-- CI_BADGE_BLOCK_END -->

> A time-locked vesting contract. Locks funds for a beneficiary; the beneficiary can withdraw only after a deadline; the owner can cancel and reclaim at any time.

## What this is

A two-actor contract: an **owner** (the depositor) and a **beneficiary** (the recipient). The owner locks ADA at the script with a datum specifying the beneficiary's pubkey hash and a Unix-timestamp deadline. The validator allows a spend if **either** the owner signs (cancellation path) **or** the beneficiary signs **and** the transaction's validity range starts after the deadline (vesting path).

This adds **time** to the simple-transfer pattern. The contract enforces a "not yet" rule that only the chain itself can answer correctly.

## Why it matters

Real example: employee compensation. An employer signs an employee on at a salary that vests after 12 months. The employer locks the funds at the vesting contract with `lock_until` set 12 months out. The employee can claim only on or after the cliff. If the employer wants to cancel before the cliff (e.g. employee leaves), they can — they're still a valid signer on the cancellation path.

The pattern generalises to any "send X to Y after time T, with Z's right to cancel" scenario: subscriptions, escrow with deadlines, time-released grants, recurring stipends, content release dates.

## How the onchain logic works

[`onchain/aiken/validators/vesting.ak`](onchain/aiken/validators/vesting.ak):

```aiken
pub type VestingDatum {
  lock_until: Int,         // POSIX time in milliseconds
  owner: ByteArray,        // owner's payment-key hash
  beneficiary: ByteArray,  // beneficiary's payment-key hash
}

validator vesting {
  spend(datum_opt: Option<VestingDatum>, _redeemer: Data, _input: OutputReference, tx: Transaction) {
    expect Some(datum) = datum_opt
    or {
      key_signed(tx.extra_signatories, datum.owner),
      and {
        key_signed(tx.extra_signatories, datum.beneficiary),
        valid_after(tx.validity_range, datum.lock_until),
      },
    }
  }
}
```

Two paths to spend the locked UTxO:

- **Owner cancels** (any time): owner's signature is in `extra_signatories`.
- **Beneficiary claims** (only after the deadline): beneficiary's signature is in `extra_signatories` AND the transaction's validity range starts after `lock_until`.

The `valid_after` check is what binds the contract to chain time. The transaction submitter declares a validity range `[from, to]` in their tx; nodes only include the tx if the chain tip is inside that range. By requiring `from > lock_until`, the validator forces the beneficiary's claim to happen on a chain tip past the deadline.

The validator file also ships several `test` blocks at the bottom that Aiken runs as unit tests during `aiken check` — happy paths and failure paths together exercise the validator's logic without needing the full chain.

## How to use it offchain

Today the only offchain implementation is Mesh.js, exposed as a class — [`offchain/meshjs/vesting.ts`](offchain/meshjs/vesting.ts):

```ts
class MeshVestingContract {
  constructor(inputs: { mesh, fetcher, submitter, wallet, networkId, version });
  depositFund(amount: Asset[], lockUntilTimestampMs: number, beneficiary: string): Promise<string>;
  withdrawFund(vestingUtxo: UTxO): Promise<string>;
}
```

`depositFund` builds a transaction sending `amount` to the script address with a `VestingDatum` carrying `lockUntilTimestampMs`, the connected wallet's pubkey hash as `owner`, and `beneficiary`'s pubkey hash. `withdrawFund` builds a spend transaction with a validity range starting "now" (which the beneficiary uses past the deadline; the owner uses any time).

The class shape — extending `MeshTxInitiator` — is library code: you import it, construct it with your wallet and provider, and call its methods. To exercise it end-to-end you write a small driver that calls `depositFund` then `withdrawFund` (an example driver lands in milestone P6).

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

`aiken check` runs the unit tests baked into the validator. You should see all five tests pass.

A runnable end-to-end driver for the offchain code is tracked as P6 work; until that lands, the offchain class is a library you import and exercise from your own driver.

## What's tested in CI

The CI workflow ([`../.github/workflows/ecosystem-test.yml`](../.github/workflows/ecosystem-test.yml)) runs `aiken check && aiken build` on every push and PR (including the validator's unit tests). The Mesh.js cell currently just loads the file (it's a library; loading succeeds and exits 0); a real integration test that exercises `depositFund` + `withdrawFund` is part of milestone P6.

## Variations to explore

- **Linear vesting.** Instead of a single cliff, allow the beneficiary to withdraw a fraction of the locked amount per time period. The validator now needs to read both how much was originally locked (datum) and how much remains (output), and check the proportion against `(now - start) / (end - start)`.
- **Multiple beneficiaries.** Replace the single beneficiary with a list, and split the funds proportionally on withdraw.
- **Slashing on early termination.** When the owner cancels before the cliff, force a portion of the funds to a fee address rather than refunding the whole amount.
