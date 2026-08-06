# HTLC — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken), and keeps its structure: the same
parameters in the same order, and the same two redeemer constructors.

## What this example shows

A Hash Time-Locked Contract gives funds exactly two ways out:

| Redeemer | Rule |
| --- | --- |
| `Guess(answer)` | `sha2_256(answer)` must equal the locked image — no signature required |
| `Withdraw` | the owner must sign, **and** the expiry must have passed |

The reveal branch is deliberately open: anyone who learns the secret can claim. That is the
point of an HTLC — in a cross-chain swap, the off-chain protocol decides who learns it, and
learning it on one chain is what lets you claim on the other.

The two branches cannot both be valid at once, because the refund is gated on a validity range
strictly after the expiry.

## Parameters, not datum

`image`, `expiration` and `owner` are validator **parameters**, applied to the script before it
is deployed:

```java
@Param static byte[] image;
@Param static BigInteger expiration;
@Param static byte[] owner;
```

Each set of values produces a different script hash, and therefore a different address. The
terms of an HTLC instance are fixed when it is created and cannot be swapped out by whoever
later builds the spending transaction — which is exactly what you want, and is not true of
terms carried in a datum.

## The flow

1. **Lock** 20 ADA, then **reveal** the secret to claim it.
2. **Lock** 10 ADA again, then attempt a refund **too early** — the validator rejects it.
3. **Wait** for the reveal window to close, then **refund** successfully.

Step 2 is what makes the time lock visible. Without it, a passing refund would prove nothing,
since it would also pass if the deadline check were missing entirely.

Timing is read from the chain's latest block rather than the local clock, so the example does
not assume the devnet's slot-to-time mapping matches this machine's wall clock.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles the validator to Plutus and runs the unit tests
./gradlew run     # executes the full flow on-chain (~1 minute, it waits out the expiry)
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

The backend defaults to Yaci DevKit on `:8080`. Point it elsewhere with:

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

## Tests

[`HtlcValidatorTest`](app/src/test/java/org/cardanofoundation/templates/HtlcValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM through `julc-testkit`, applying the
parameters exactly as they are applied on-chain.

Two of the cases are there for safety rather than coverage:

- `refundFailsWhenTheTransactionHasNoLowerBound` — a transaction with an unbounded lower bound
  could be included at any time, so it proves nothing about the expiry having passed.
- `refundFailsExactlyAtTheExpiry` — landing on the deadline is not "after" it.

## Two julc gotchas worth knowing

**Parameters must be `static` fields.** julc's own documentation shows `@Param` on instance
fields, but that does not compile: javac rejects reading an instance field from a static
entrypoint, and making the entrypoint an instance method hides it from `julc-testkit`, which
resolves entrypoints statically. Static fields satisfy both.

**Do not use `IntervalLib.finiteLowerBound` for deadline checks.** It returns `-1` when the
bound is unbounded, and comparing that sentinel as if it were a timestamp silently treats a
missing bound as a real time. This validator matches on `IntervalBoundType` directly and
rejects anything that is not `Finite`.
