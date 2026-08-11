# Crowdfund — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: the same three
parameters, the same datum, and the same three redeemers in the same constructor order.

## What this example shows

An all-or-nothing crowdfund. Donations accumulate in a single script UTxO whose datum is a ledger
of who gave what. After the deadline exactly one of two things happens: the goal was met and the
beneficiary takes the pot, or it was not and every donor recovers precisely their own stake.

The campaign's terms — beneficiary, goal, deadline — are script **parameters**, so they are fixed
in the address itself. A donor can check what they are giving to before giving.

## The ledger must balance exactly

Donating requires the datum to sum to **exactly** the new balance — not at least, not at most.

That single rule is what makes refunds safe. If a donor could write themselves in for more than
they put in, a failed campaign would let them walk away with other people's money; if the ledger
could undercount, some of the pot would become unattributable and nobody could reclaim it. The
on-chain run proves the overstating case, and the unit tests cover both directions.

A consequence worth knowing: the campaign's *minimum ada* has to belong to someone too. There is
no unattributed float, so the first donor is credited with the whole opening balance.

## Refunds are per-donor, and once only

`Reclaim` pays out only to donors who **signed** the transaction, and only what the ledger says
they gave. Several donors can reclaim together, which is why there are two shapes:

- if the signers' combined contributions are the whole balance, they drain the UTxO;
- otherwise they must **rebuild** it for everyone still owed.

In the rebuild case every signer must be **struck from the ledger**. That is the anti-replay
rule: leaving a reclaiming donor in place would let them come back and be paid for the same
contribution again. It is proven on chain.

## A quirk inherited from the original

Exactly *at* the goal, **both exits are open**: withdrawal needs `balance >= goal` and a full
reclaim needs `balance <= goal`, so whichever transaction lands first decides where the money
goes.

This is faithful to the Aiken original rather than a slip in the port, and
`exactlyOnTheGoalBothExitsAreOpen` asserts it so the ambiguity is recorded rather than discovered
later by someone relying on it.

## The flow

The run drives the **failed-campaign** path, because that is where the interesting guarantees are.

1. Alice **opens** the campaign, credited with everything in it.
2. Bob attempts a donation that **overstates** his contribution — rejected.
3. Bob **donates** honestly.
4. The beneficiary attempts to **withdraw** a campaign short of its goal — rejected.
5. Bob attempts to **reclaim while remaining in the ledger** — rejected.
6. Bob **reclaims**, rebuilding the campaign for Alice alone.
7. Alice **takes the rest**, closing it.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles the validator to Plutus and runs the unit tests
./gradlew run     # executes the failed-campaign flow on-chain
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

## What the on-chain run does not cover

The **deadline** is set to zero, so it has always passed. This devnet reports a block's `slot` and
its `time` out of step with each other, so a deadline derived from block time is not reliably
comparable against a slot-derived transaction bound — testing it on chain would produce a result
that proved nothing either way.

The time gate is covered instead by the unit tests, which drive the same compiled validator with
exact validity ranges: withdrawing early, reclaiming early, and ranges with no lower bound at all.

## Gotcha worth knowing

**`MapLib.lookup` returns an `Optional`, and that does not lower from inside a helper.** Summing
what the signers are owed walks `MapLib.keys` and `MapLib.values` side by side instead — a little
more code, but it compiles and reads honestly as "for each donor, add their amount if they
signed".
