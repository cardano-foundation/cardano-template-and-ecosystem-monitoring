# Learning Cardano with this repo

This repo implements the 21 most common smart-contract patterns from Massimo Bartoletti et al.'s *Smart Contract Languages: A Comparative Analysis* on Cardano, each in multiple onchain and offchain frameworks. Read it as a textbook: pick the smallest pattern, read both sides, then move to the next.

## Where to start

If this is your first Cardano contract, read in this order:

1. **[`simple-transfer`](../simple-transfer/README.md)** — the minimum-viable Cardano dApp: a script locks ADA, a redeemer releases it. Demonstrates UTxO inputs/outputs, datum, redeemer, and the offchain → onchain → ledger round trip with no extra concepts.
2. **[`vesting`](../vesting/README.md)** — adds time. The script enforces a deadline before the beneficiary can withdraw. Introduces validity ranges and on-chain time.
3. **[`htlc`](../htlc/README.md)** — adds a hash pre-image. Two parties: the locker and the guesser; whoever supplies the matching pre-image before expiry takes the funds. Introduces hashes as access controls and the dual-path validator pattern.
4. **[`escrow`](../escrow/README.md)** — adds multiple parties and state machines. A depositor and recipient with deadline-based refund/release paths. Introduces multi-party signature checks and contract state in datums.
5. **[`atomic-transaction`](../atomic-transaction/README.md)** — adds the all-or-nothing contract pattern: a single transaction that spends a script UTxO and mints a token, with both succeeding or failing together.

After those, branch into whichever pattern matches your project:

| If you're building... | Read |
|---|---|
| A DeFi swap | [`constant-product-amm`](../constant-product-amm/README.md) (placeholder) |
| A token-locking contract for a delegated payee | [`token-transfer`](../token-transfer/README.md) |
| A factory pattern (mint multiple parametrised contracts from one root) | [`factory`](../factory/README.md) |
| A crowdfunding contract | [`crowdfund`](../crowdfund/README.md) |
| An auction | [`auction`](../auction/README.md) |
| A lottery | [`lottery`](../lottery/README.md) |
| A bet with an oracle | [`bet`](../bet/README.md) or [`pricebet`](../pricebet/README.md) |
| A vault with delayed-recovery semantics | [`vault`](../vault/README.md) |
| A payment splitter | [`payment-splitter`](../payment-splitter/README.md) |
| An anonymous data-anchoring contract | [`anonymous-data`](../anonymous-data/README.md) |
| Off-chain integrity proofs | [`storage`](../storage/README.md) |
| An identity contract | [`decentralized-identity`](../decentralized-identity/README.md) |
| Upgradable contracts via proxy delegation | [`upgradable-proxy`](../upgradable-proxy/README.md) |
| A self-sovereign wallet in a contract | [`simple-wallet`](../simple-wallet/README.md) |
| Editable NFT metadata | [`editable-nft`](../editable-nft/README.md) (placeholder) |

## How to read each use case

Every use case has the same shape:

```
<use-case>/
  README.md          ← start here
  example.yml        ← manifest declaring which onchain/offchain implementations exist
  onchain/aiken/     ← the validator (the on-chain contract)
  offchain/<sdk>/    ← one folder per offchain SDK; each builds and submits the transaction
```

For a given use case, read in this order:

1. **The README.** A use-case README at its best answers: *what does this contract do, why does it matter, how does the on-chain logic work, how do I use it, what's tested.* **In practice today, README quality varies**: the 5 use cases on the recommended starting path above have tutorial-grade content; many of the others currently describe the contract pattern but skip the walkthrough. If a README isn't enough, jump to step 2.
2. **The validator** (`onchain/aiken/validators/*.ak`). The validator is the source of truth for what the contract enforces — and it's often the most concise way to understand a use case in detail.
3. **One offchain implementation.** Pick the SDK you're already using (or the most-readable one — Lucid Evolution is a good first pick if you're new). The offchain code shows how to build the transaction the validator expects.
4. **A second offchain implementation, if you want to compare.** Reading the same contract through two SDKs is the fastest way to understand which differences are SDK-cosmetic and which are protocol-essential.

## Trying things locally

To run any use case end-to-end against a local Cardano-compatible test environment ([Yaci DevKit](https://github.com/bloxbean/yaci-devkit)), follow [`how-to/run-locally.md`](how-to/run-locally.md). For most examples this is `cd <use-case>/offchain/<sdk> && deno run --allow-all <entry>.ts` (or the equivalent jbang command for ccl-java).

## What you won't find here

- **A Plutus / Aiken / Mesh / Lucid tutorial.** This repo expects you to know the basics of one of those tools — or to learn the basics elsewhere first ([Aiken book](https://aiken-lang.org/), [Mesh.js docs](https://meshjs.dev/), [Lucid Evolution docs](https://docs.evolution-sdk.com/), [cardano-client-lib docs](https://github.com/bloxbean/cardano-client-lib/wiki)) and use this repo to see the patterns applied.
- **Production-readiness audits.** These are educational implementations. Every use-case README has a "what's tested in CI" section so you can see exactly what guarantees you're inheriting.
- **A unified runtime.** Each SDK runs its own examples; the matrix shows you which combinations work today.
