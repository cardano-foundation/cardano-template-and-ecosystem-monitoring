# Documentation

This is the entry point for everything that is not a use-case `README.md`. The repo serves two distinct audiences and each gets a clear path.

## I'm here to learn Cardano

Read [`learn.md`](learn.md). It is a curated tour of the 21 use cases in a recommended reading order, with notes on what each one teaches and which SDK to start with.

Once you have picked a use case, its top-level `README.md` (e.g. [`escrow/README.md`](../escrow/README.md)) walks you through that contract specifically. **README quality varies today**: some use cases have full tutorial content (with onchain walkthrough, offchain example, "try it yourself" commands); others currently just describe the contract pattern at a high level. The 5 use cases on `learn.md`'s recommended starting path (simple-transfer → vesting → htlc → escrow → atomic-transaction) are the ones first targeted for tutorial-grade rewrites. Improvements to the rest are tracked as ongoing work.

## I'm here to track ecosystem health

The repo's CI matrix runs every (use case × onchain language × offchain SDK) combination on every push and on a nightly drift schedule. The current matrix is rendered in the GitHub Actions step summary of every workflow run. A public dashboard rendering the same data lives at [TBD — Phase 4 deliverable]; until that ships, the workflow run logs are the canonical source.

## I'm contributing

| What you want to do | Read |
|---|---|
| Add a new offchain SDK or onchain language | [`how-to/add-framework.md`](how-to/add-framework.md) |
| Add an implementation of an existing use case in a registered framework | [`how-to/add-use-case-implementation.md`](how-to/add-use-case-implementation.md) |
| Run the test matrix locally | [`how-to/run-locally.md`](how-to/run-locally.md) |
| Understand the design decisions | [`design.md`](design.md) |
| Look up a schema (manifest, framework descriptor, result.json) | [`schemas.md`](schemas.md) |

The repo's top-level [`README.md`](../README.md) is the front door for casual readers; this `docs/README.md` is the front door for contributors.
