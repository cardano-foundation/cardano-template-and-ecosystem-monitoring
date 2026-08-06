# Auction — Java fullstack

On-chain **and** off-chain in one Java project. The validators are written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: one
multi-validator, the same datum, and the same three redeemers in the same constructor order.

## What this example shows

An English auction. The item sits at the script address alongside the current best bid; bidding
replaces that UTxO with a better one; settlement after the deadline sends the item to the winner
and the money to the seller.

## Refunds are inline, not a claim step

The property worth understanding is that **a losing bidder is repaid in the very transaction that
outbids them**.

That is a deliberate design choice, and it has consequences that show up all over the contract.
There is no queue of stranded deposits, nobody has to remember to come back and claim anything,
and a bidder's funds are never held hostage by an auction that goes quiet. It is also why the
`Withdraw` branch exists **only to be refused**: with refunds settled inline, a standalone
withdrawal would need per-bidder accounting the contract deliberately does not keep.

The refund must be *exact* — the previous bidder's full stake, to their address. A partial refund
is not a refund, and the on-chain run proves both that case and the missing-refund case.

## Settlement is final by shape

Ending the auction requires **exactly one output to carry the item**, and **none to return to the
script**.

Those two clauses are what make the ending final rather than merely intended. One output carrying
the asset means "who won" is unambiguous; no continuing output means there is no stale listing
left behind that could keep taking bids after the item has already gone.

With a winner, the seller's signature is *not* required — the terms were fixed when the auction
was created, and the winner must be able to collect without the seller's cooperation. With no
bids the seller does sign, because returning an unsold item is their choice to make.

## The flow

1. The seller **lists** the item (minting it and the auction token together).
2. Alice **bids**.
3. Bob attempts to **outbid without refunding** Alice — rejected.
4. Bob attempts a **partial refund** — rejected.
5. Bob attempts a **non-increasing bid** — rejected.
6. Bob **outbids** properly, refunding Alice in the same transaction.

The run then asserts, from the confirmed transaction, both that the auction UTxO was spent and
that Alice's full stake landed back with her.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles both validators to Plutus and runs the unit tests
./gradlew run     # executes the bidding flow on-chain
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

## What the on-chain run does not cover

Settlement (`End`) is **not** exercised on chain. This devnet reports a block's `slot` and its
`time` out of step with each other, so a deadline derived from block time is not reliably
comparable against a slot-derived transaction bound — attempting it would produce a result that
proved nothing either way.

`End` is covered instead by the unit tests, which drive the same compiled validator on a real
Plutus VM with exact validity ranges: the item reaching the wrong party, the seller being
underpaid, a stale listing left behind, the asset split across two destinations, and an unsold
item going anywhere but home.

## Tests

[`AuctionValidatorTest`](app/src/test/java/org/cardanofoundation/templates/AuctionValidatorTest.java)
covers both entry points.

`firstBidNeedsNoRefund` is there for a reason that is easy to miss: with no previous bidder the
refund rule must not fire spuriously, and the empty-bidder sentinel is what makes that
distinguishable from "a bidder who happens to be owed nothing".
