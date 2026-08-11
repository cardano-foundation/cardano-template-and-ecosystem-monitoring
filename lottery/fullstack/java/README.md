# Lottery — Java fullstack

On-chain **and** off-chain in one Java project. The validators are written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: the same two
validators with the same parameters, the same datum, and the same five redeemers in the same
constructor order.

## What this example shows

A two-player lottery decided by numbers **neither player can grind**.

Both players publish `blake2b_256(number)` up front, then reveal in a fixed order: player 1
first, player 2 second. The winner is the parity of the sum.

The ordering rule is the entire security argument. Player 2 can see player 1's *commitment* from
the start but not the number behind it — and by the time player 1 reveals, player 2's own
commitment is already locked in. Neither player ever chooses a number while the other's is
known. Reverse the order and the scheme collapses: player 1 would be picking last, with player
2's number public, and could simply choose one that wins.

## Two scripts

| Class | Kind | Job |
| --- | --- | --- |
| [`LotteryCreatorValidator`](app/src/main/java/org/cardanofoundation/templates/validator/LotteryCreatorValidator.java) | mint | opens a game (both players must sign) and burns the token to close it |
| [`LotteryValidator`](app/src/main/java/org/cardanofoundation/templates/validator/LotteryValidator.java) | spend | the five moves: `Reveal1`, `Reveal2`, `Timeout1`, `Timeout2`, `Settle` |

Both are parameterised on a game index, so independent games get independent policies. The
lottery script additionally takes the policy id, and requires the UTxO it is spending to carry
that token — otherwise a look-alike output at the same address could drive a settlement for a
game that never existed.

## The sentinel

`n1` and `n2` are empty bytestrings until revealed, rather than an `Option`. That keeps the datum
flat and cheap to compare, and gives "not yet revealed" exactly one representation.

It also explains a rule that looks arbitrary at first: opening a game rejects an **empty
commitment**, and a reveal rejects an **empty number**. Without those, a game could be opened
whose commitment any reveal trivially matches.

## Timeouts are asymmetric

A player who simply stops must not be able to freeze the pot, so either side can claim after the
window closes. The two paths are deliberately *not* symmetric:

- **`Timeout1`** — player 1 never revealed. Player 2 claims after `endReveal`.
- **`Timeout2`** — player 1 revealed but player 2 did not. Player 1 claims after
  `endReveal + delta`.

The extra grace exists because player 2's window only opens once player 1 has moved. Ending both
at the same instant would let player 1 reveal in the final slots and immediately claim, leaving
player 2 no realistic chance to respond.

## The flow

1. **Open** — mint the game token, lock the pot, record both commitments.
2. Attempt **player 2 revealing first** — rejected. This is the anti-grinding rule.
3. Attempt a **reveal that does not match the commitment** — rejected.
4. **Player 1 reveals.**
5. Attempt to **settle with one number** — rejected.
6. **Player 2 reveals**, then **settle**: 3 + 4 is odd, so player 1 takes the pot and the token
   is burned.

Each rejection is a phase-2 evaluation failure — the validator ran and said no. A transaction
cardano-client-lib merely failed to *build* would look similar in the log but prove nothing.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles both validators to Plutus and runs the unit tests
./gradlew run     # executes the full flow on-chain
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

The backend defaults to Yaci DevKit on `:8080`. Point it elsewhere with:

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

Player 2 is a fresh account that never needs funding — it only ever signs, while player 1 pays
every fee. The reveal window is read from chain time rather than the local clock, so the example
does not assume the devnet's slot-to-time mapping matches this machine.

## Tests

[`LotteryValidatorTest`](app/src/test/java/org/cardanofoundation/templates/LotteryValidatorTest.java)
evaluates both **compiled** scripts on a real Plutus VM through `julc-testkit`, including the two
timeout paths that the on-chain run cannot reach without waiting out a real deadline.

`timeoutsRejectAnUnboundedValidityRange` is there for safety rather than coverage: a transaction
with no lower bound could be included at any time, so it proves nothing about a deadline having
passed. `parityPicksTheOtherWinner` runs the same game with a different `n1` and checks the pot
goes the other way — a settlement test that only ever produced one winner would pass even if the
parity rule were ignored entirely.

## Gotchas worth knowing

**Reveals do not check the continuing datum.** The validator requires the game to continue —
an output must remain at the script address — but does not verify that the new datum records the
revealed number. This is faithful to the Aiken original, which leaves state reconstruction to
the off-chain code. It is worth knowing before adapting this for real use.

**Shared types belong in the `@OnchainLibrary`.** `LotteryDatum` is read by both scripts. Nested
inside a validator class it fails to lower from the other with `Unknown type`, because each
validator is its own compilation unit.

**A test harness can pass for the wrong reason.** The timeout cases here originally supplied a
*continuing* output, which timeouts forbid. The positives failed, which is how it was caught —
but the negatives had been passing on the continuing output rather than on the deadline they
claimed to test.
