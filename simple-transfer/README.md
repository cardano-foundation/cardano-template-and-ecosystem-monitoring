# Simple transfer

<!-- CI_BADGE_BLOCK_BEGIN -->
[![Ecosystem tests · simple-transfer](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml/badge.svg?branch=feat/ecosystem-monitoring-and-learning-enhancement)](https://github.com/cardano-foundation/cardano-template-and-ecosystem-monitoring/actions/workflows/ecosystem-test.yml)
<!-- CI_BADGE_BLOCK_END -->

> A script that locks ADA at an address; only a specific receiver — set when the script is parameterised — can unlock it.

## What this is

The minimum-viable Cardano dApp. A sender locks ADA at a script address; the redeemer carries no information; the validator only checks that the transaction is signed by the receiver whose verification-key hash was baked into the script when it was deployed.

It is the smallest contract that exercises every concept of the eUTxO model: a parameterised validator (the receiver pubkey hash is a *parameter*, not a datum), a datum (unused here), a redeemer (also unused), and a signature requirement enforced on chain.

## Why it matters

Real example: payroll. An employer wants to send 5 ADA to an employee on Friday. The employer locks the funds at a script parameterised with the employee's pubkey hash. Anyone watching the chain can see the funds are reserved. Only the employee can spend them, and the employer cannot recall the funds without the employee's signature — solving "I sent the funds to the wrong address" by making the receiver explicit at lock time.

Once you can read and modify *this* contract, every other pattern in this repo is the same shape with more conditions in the validator.

## How the onchain logic works

[`onchain/aiken/validators/simple-transfer.ak`](onchain/aiken/validators/simple-transfer.ak), the whole thing:

```aiken
validator simpleTransfer(receiver: VerificationKeyHash) {
  spend(_datum_opt: Option<Data>, _redeemer: Data, _utxo: OutputReference, self: Transaction) {
    key_signed(self.extra_signatories, receiver)
  }
}
```

- `simpleTransfer` is a **parameterised** validator. Different receivers produce different on-chain script addresses; the receiver's pubkey hash is fixed at the moment the script is built (off-chain) and cannot be changed afterwards.
- The `spend` handler ignores both the datum and the redeemer — neither carries information for this contract — and only checks that `receiver`'s pubkey hash appears in the transaction's `extra_signatories` list.
- Anyone can lock funds at the address (the validator runs only on *spend*); only the receiver can unlock them.

## How to use it offchain

The Lucid Evolution implementation is the most readable starting point. [`offchain/lucid-evolution/simple-transfer.ts`](offchain/lucid-evolution/simple-transfer.ts) exposes four CLI subcommands:

| Command | What it does |
|---------|--------------|
| `prepare <count>` | Generates `<count>` test wallets in the working directory (`wallet_0.txt`, …) seeded with fresh mnemonics. |
| `lock <amount> <receiverAddress> [walletIndex]` | Builds the parameterised script for `receiverAddress`, sends `<amount>` lovelace to that script address. |
| `claim [walletIndex]` | Looks up UTxOs at the parameterised script address for this wallet's pubkey hash, builds a spend transaction, and submits. |
| `balance [walletIndex]` | Shows the wallet's balance (utility). |

The Mesh.js and CCL-Java implementations follow the same pattern with their respective SDK idioms — read either after the Lucid one to see how the same logic shows up in a different stack.

## Try it yourself

You'll need [Yaci DevKit](https://devkit.yaci.xyz/) running locally:

```sh
yaci-devkit up --enable-yaci-store
```

Build the contract:

```sh
cd onchain/aiken
aiken check && aiken build
cd -
```

Then exercise the offchain flow (Lucid Evolution):

```sh
cd offchain/lucid-evolution
deno task prepare 2                  # creates wallet_0.txt and wallet_1.txt
# Lock 5 ADA for wallet 1's address (you'll need wallet 1's address here)
deno task lock 5000000 <addr_of_wallet_1>
deno task claim 1                    # wallet 1 claims
```

For the CCL-Java equivalent: `cd offchain/ccl-java && jbang SimpleTransfer.java`. For Mesh.js: `cd offchain/meshjs && deno run --allow-all simple-transfer.ts deposit ...` (see [`offchain/meshjs/`](offchain/meshjs/) for the CLI).

## What's tested in CI

The CI workflow ([`../.github/workflows/ecosystem-test.yml`](../.github/workflows/ecosystem-test.yml)) runs every implementation on every push and PR. Today the offchain examples are CLI tools that exit with a usage error on no-args (so the cells appear as red — see the milestone P6 follow-on for proper end-to-end integration tests). The `aiken check` step exercises the validator's built-in unit tests.

## Variations to explore

- **Make the receiver a script address, not a pubkey hash.** Replace the `key_signed` check with an "any input is from script X" check. Now the receiver can be any contract, opening the door to programmable payouts.
- **Add an expiry.** Borrow the `valid_after` pattern from [`htlc`](../htlc/) and let the sender reclaim funds after a deadline.
- **Add a fee.** Have the script require a small payment to a fee address as part of any unlock — a primitive smart-contract toll.
