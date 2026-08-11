# Price Bet — Java fullstack

On-chain **and** off-chain in one Java project. The validators are written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: the same datum,
the same three redeemers in the same constructor order, and the same oracle datum encoding.

## What this example shows

A bet on whether a price clears a target before a deadline, settled by an oracle.

The owner stakes first and names the terms; a player joins by matching the stake. At settlement
the oracle's reading is consulted as a **reference input** — read, not consumed.

That last detail is the interesting one. If settling *spent* the reading, one player claiming
their winnings would destroy the price everyone else's bet depended on, and bets would have to
queue for the oracle one per block. Referencing it means any number of bets can resolve against
the same reading in the same block. The example asserts the reading is still unspent afterwards,
because a version that consumed it would otherwise look identical from the outside.

## Two scripts

| Class | Kind | Job |
| --- | --- | --- |
| [`BetValidator`](app/src/main/java/org/cardanofoundation/templates/validator/BetValidator.java) | spend | `Join`, `Win`, `Timeout` |
| [`OracleValidator`](app/src/main/java/org/cardanofoundation/templates/validator/OracleValidator.java) | spend | holds a reading at a stable address; refuses every spend |

The oracle script exists so the example is self-contained — a real deployment would point
`oracleHash` at whichever oracle it trusts. It refuses all spends, so a published reading cannot
be quietly withdrawn or rewritten while bets rely on it: issuing a correction means publishing a
new UTxO and leaving the old one visible.

## The bet pins its oracle

`oracleHash` lives in the datum, and **every transition carries it over unchanged**. That is the
rule the design turns on. Without it, a player could join and swap in an oracle that always
reports a winning price — the bet would look well-formed and settle in their favour every time.
The on-chain run proves this refusal explicitly.

Joining is similarly narrow: the target, the deadline and the stake must all survive untouched,
and the signer must be the player being recorded, so nobody can enrol a third party into a bet
they never agreed to.

## Win and Timeout cannot overlap

- **`Win`** requires the transaction to end **at or before** the deadline.
- **`Timeout`** requires it to start **strictly after**.

There is no slot in which both are valid, so the pot always has exactly one destination.
`cannotReclaimExactlyAtTheDeadline` pins that boundary.

A reading must also still be unexpired at the transaction's upper bound, so a stale price cannot
be used to settle long after it was published.

## The flow

1. **Fund the player**, so the stake they put up is genuinely theirs rather than the owner paying
   both sides.
2. **Publish two readings** at the same oracle — one clearing the target, one falling short. The
   losing case then differs from the winning one only in the number.
3. **Open the bet**, then attempt to **join while swapping the oracle** — rejected — and to
   **join while underfunding the pot** — rejected.
4. **Join** properly.
5. Attempt to **win on the short reading** — rejected.
6. **Win** on the good reading; the player takes the pot and the reading survives.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles both validators to Plutus and runs the unit tests
./gradlew run     # executes the full flow on-chain
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

## Tests

[`PriceBetValidatorTest`](app/src/test/java/org/cardanofoundation/templates/PriceBetValidatorTest.java)
evaluates both **compiled** scripts on a real Plutus VM, including the `Timeout` path that the
on-chain run cannot reach without waiting out a real deadline.

## Gotchas worth knowing

**`Optional` does not lower from arbitrary depth.** `MapLib.lookup` returns an `Optional`, and
calling `.get()` on it from inside a library helper two calls deep fails with
`Unbound variable: get`. The oracle map is read by walking its keys and values directly instead.

**A zero-argument "always fail" helper poisons the whole module.** Modelling Aiken's `fail` as a
method whose body aborts caused *every* entrypoint to fail with `head of empty list` — julc binds
library definitions strictly, so the abort ran at binding time rather than when reached. The fix
was to state the oracle checks as predicates (`priceAtLeast`, `readingIsFresh`) whose non-price
variants simply answer `false`, which needs no fabricated value at all.

**Never make the fee payer a payee of an amount the validator checks.** The player claiming the
pot must not also pay the fee: cardano-client-lib merges their payout and their change into one
output and takes the fee from it, leaving them a few hundred thousand lovelace short of the
`>= pot` the validator requires. The owner pays the fee here.
