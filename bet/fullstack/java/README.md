# Bet — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: one
multi-validator, the same datum, and the same two redeemers in the same constructor order.

## What this example shows

A two-player bet settled by a referee.

Player 1 stakes and names the terms. Player 2 matches the stake to make it live. After the
window closes, the oracle names one of the two players and the pot goes to them.

## One script, two jobs

[`BetValidator`](app/src/main/java/org/cardanofoundation/templates/validator/BetValidator.java)
is a `@MultiValidator`: it mints the token that gives a bet its identity, **and** guards the UTxO
that token travels with.

That pairing is worth more than convenience. A multi-validator's policy id *is* its script hash,
so the contract can ask a question about itself — "does this UTxO carry a token minted by the
script that owns it?" — and get an answer nobody can forge. Without it, anyone could build a
look-alike output at the same address, with any datum they liked, and "join" a bet that never
existed.

## Conflicts of interest are the real subject

A bet is only meaningful if the person deciding it has nothing riding on the answer, so the
referee may be neither player — and that is checked **twice**, because there are two moments at
which it could be violated:

- **At creation**, the oracle may not be player 1. A creator who is also the referee could simply
  declare themselves the winner and take the opponent's stake.
- **At join**, the joiner may be neither player 1 nor the oracle. Otherwise the referee could
  quietly take a side after the terms were set.

The stake must be matched **exactly**, not merely met: a symmetric bet is the whole premise, and
an over- or under-funded pot silently changes the odds.

## The payout shape is the payout rule

Settlement requires **exactly one output, carrying no datum, paying the named winner directly**.

Each clause removes a way to cheat. One output means there is nowhere for a slice of the pot to
be diverted. No datum means no continuing state pretending a settled bet is still live. Paying
the *named* winner means the oracle cannot announce one player and pay another.

The off-chain side follows from that: the settling transaction has no explicit payment at all.
Everything, including the bet token, flows to the winner as the single change output.

## The flow

1. Attempt to **create a bet naming yourself as oracle** — rejected.
2. **Create** the bet properly.
3. Attempt to **join your own bet** — rejected.
4. Attempt to **join with an under-funded pot** — rejected.
5. **Join.**
6. Attempt to **settle early** — rejected.
7. Wait for the window to close, then **settle**.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles the validator to Plutus and runs the unit tests
./gradlew run     # executes the full flow on-chain (it waits out the betting window)
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

Player 2 and the oracle are fresh accounts, funded just enough to sign.

## A note on time

This devnet reports a block's `slot` and its `time` **out of step with each other** — by roughly
ten minutes in testing. A deadline computed from block time therefore cannot be compared directly
against a transaction bound expressed in slots, which is how the first version of this example
failed: the datum's expiry sat *before* the transaction's own upper bound, so a perfectly ordinary
creation looked like it was already too late.

Rather than hard-code that skew, the betting window is wide enough to absorb it and settlement
**retries until the chain accepts it**. The first attempt that succeeds is, by definition, the
first one the chain considers past the expiry — which needs no assumption about the mapping at
all. The early-settlement rejection is simply the first attempt.

## Tests

[`BetValidatorTest`](app/src/test/java/org/cardanofoundation/templates/BetValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM through `julc-testkit`, covering both
entry points.

`cannotSettleExactlyAtTheExpiry` pins the boundary — landing on the deadline is not past it —
and `settlementAllowsOnlyOneOutput` and `thePayoutMustGoToTheNamedWinner` cover the two ways a
dishonest referee could otherwise redirect the pot while producing a transaction that still looks
well-formed.

## Gotcha worth knowing

**`mintAsset(script, assets, redeemer, receiver, datum)` sends only the token's minimum ada.**
Using it to open the bet locked ~1.37 ada instead of the intended stake — invisible until the
join rule, which checks for *exactly* double, refused a correct-looking join. Stating the mint
and the payout separately is what makes the stake explicit.
