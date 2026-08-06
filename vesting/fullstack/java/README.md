# Vesting — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its datum layout and rule.

## What this example shows

Funds are locked with a release schedule, and there are two ways out:

| Signer | Rule |
| --- | --- |
| owner | may reclaim at **any** time |
| beneficiary | may collect only once `lockUntil` has passed |

The owner's clawback is deliberately unconditional. Without it, funds sent with a wrong
beneficiary would be locked away permanently.

## Schedule in the datum, not in parameters

`lockUntil`, `owner` and `beneficiary` live in the **datum**:

```java
public record VestingDatum(BigInteger lockUntil, byte[] owner, byte[] beneficiary) {}
```

That means one script address hosts many independent vesting schedules — each locked UTxO
carries its own. (Contrast [htlc](../../../htlc/fullstack/java), where the terms are validator
*parameters* and each instance gets its own address.)

`lockUntil` is POSIX time in **milliseconds**, matching the transaction time Plutus sees.

## The flow

1. **Lock**, then **claw back** immediately as the owner — no waiting, because that branch is
   not time-gated.
2. **Lock** again, then try to collect as the beneficiary **too early** — the validator
   rejects it.
3. **Wait** for the lock to elapse, then collect successfully.

Step 2 is what makes the schedule visible. A passing collection on its own would prove
nothing, since it would also pass if the deadline check were missing entirely.

The owner and beneficiary are **different accounts**, so the two branches are genuinely
distinguishable. The beneficiary is never funded — it only signs, and the owner pays every
fee.

Timing is read from the chain's latest block rather than the local clock, so the example does
not assume the devnet's slot-to-time mapping matches this machine's wall clock.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles the validator to Plutus and runs the unit tests
./gradlew run     # executes the full flow on-chain (~1 minute, it waits out the lock)
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

The backend defaults to Yaci DevKit on `:8080`. Point it elsewhere with:

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

## Tests

[`VestingValidatorTest`](app/src/test/java/org/cardanofoundation/templates/VestingValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM through `julc-testkit`.

Three cases are there for safety rather than coverage:

- `beneficiaryCannotCollectWithAnUnboundedRange` — a transaction with an unbounded lower bound
  could be included at any time, so it proves nothing about the lock having elapsed.
- `beneficiaryCannotCollectExactlyAtTheDeadline` — landing on the deadline is not "after" it.
- `ownerCanReclaimWithAnUnboundedRange` — the clawback must *not* have picked up a time
  constraint by accident.

## A julc gotcha worth knowing

**Do not use `IntervalLib.finiteLowerBound` for deadline checks.** It returns `-1` when the
bound is unbounded, and comparing that sentinel as if it were a timestamp silently treats a
missing bound as a real time. This validator matches on `IntervalBoundType` directly and
rejects anything that is not `Finite`.
