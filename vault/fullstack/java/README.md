# Vault — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: the same two
parameters, the same datum, and the same three redeemers in the same constructor order.

## What this example shows

A time-locked vault where taking money out is deliberately slow.

| Redeemer | Effect |
| --- | --- |
| `Withdraw` | **schedules** a withdrawal — stamps the vault with a `lockTime`, moves nothing |
| `Finalize` | **collects** the funds, but only after `lockTime + waitTime` |
| `Cancel` | **aborts** a scheduled withdrawal, leaving the funds where they are |

The delay is not there to protect the owner from their own impulses. It is there so that **a
stolen key is not immediately a stolen balance**: a thief must announce the theft on chain by
scheduling it, and the real owner has the entire cool-down to notice and cancel.

`waitTime` is a script parameter, so a vault's cool-down is baked into its address and cannot be
shortened by whoever later builds the transaction.

## The rule that is easy to miss

Scheduling requires the new `lockTime` to be **already in the past**.

Without that, the delay would be defeatable without breaking any other rule: wait out most of a
cool-down, then re-schedule stamping a *future* `lockTime`… and the arithmetic
`lockTime + waitTime` would still be satisfied sooner than the address promised. The clock has to
be unable to run backwards for the cool-down to mean anything.

Scheduling and cancelling also both **conserve** the balance — every lovelace that leaves the
vault must go straight back in. Otherwise "scheduling" would be a withdrawal by another name.

## The flow

1. **Deposit.** The validator only runs on the way out.
2. Attempt to **finalize immediately** — rejected; nothing has matured.
3. Attempt to **schedule while draining** some of the balance — rejected.
4. **Schedule** a withdrawal.
5. **Cancel** it — the move a real owner makes on spotting a theft.
6. **Schedule again** and **collect**.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles the validator to Plutus and runs the unit tests
./gradlew run     # executes the full flow on-chain
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

## A note on time, and what the on-chain run does not prove

This devnet reports a block's `slot` and its `time` **out of step with each other**, and not by a
stable amount — a stamp taken from block time was accepted as "past" in one run and rejected in
the next. So the run avoids depending on that clock at all:

- a **schedule** stamps `lockTime = 0`, which is unambiguously in the past under any clock;
- the **deposit** carries a stamp far in the future, so the early-`Finalize` attempt is refused
  on time grounds and nothing else.

The honest consequence: the cool-down measured from zero has also long elapsed, so the on-chain
run demonstrates the *happy path* and the *time-gating of an unmatured withdrawal*, but it does
not sit through a real cool-down. The boundaries — finalizing one millisecond early, finalizing
exactly on the deadline — are pinned by the unit tests, which drive the same compiled validator
on a Plutus VM with exact validity ranges.

## Tests

[`VaultValidatorTest`](app/src/test/java/org/cardanofoundation/templates/VaultValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM through `julc-testkit`, with the
parameters applied exactly as they are on chain.

`cannotScheduleWithAFutureLockTime` is the one worth reading: it is the only test that fails if
the "already in the past" rule is dropped, and every other test still passes without it.
`cannotFinalizeExactlyAtTheCoolDown` pins the boundary, and the two unbounded-range cases cover
transactions that could be included at any time and therefore prove nothing about elapsed time.

## Gotcha worth knowing

**A cast-and-accessor chain inside a lambda does not lower.** Reading a continuing output's
`lockTime` as
`((WithdrawDatum) (Object) OutputLib.getInlineDatum(output)).lockTime()` inside `.all(...)` fails
with `Unbound variable: lockTime`. Binding the cast to a local in a small helper fixes it.

**`null` is rejected outright**, with a good diagnostic: julc emits `JULC0017 - null is not
supported on-chain` and suggests `Optional`.
