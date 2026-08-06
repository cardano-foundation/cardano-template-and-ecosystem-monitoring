# Decentralized Identity — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: the same datum,
the same three redeemers in the same constructor order, and the same rules.

## What this example shows

A self-sovereign identity: one UTxO holding an owner key and a list of time-bounded delegates.

The UTxO is a pure **state cell**. Its value never moves — every transition requires the output
to carry exactly what the input carried — so the contract holds nothing worth stealing. What it
holds is *authority*: an address book other contracts can consult to decide who may act on this
identity's behalf.

## One change at a time

All three transitions are owner-only, and each may change only the thing it names:

| Redeemer | Changes | Everything else |
| --- | --- | --- |
| `TransferOwner { newOwner }` | the owner key | delegates and value carry over |
| `AddDelegate { delegate, expires }` | appends exactly one delegate | owner and value carry over |
| `RemoveDelegate { delegate }` | drops exactly one delegate | owner and value carry over |

That narrowness is what makes the cell auditable. Someone comparing two consecutive versions can
attribute every difference to exactly one action — there is no transition that could plausibly
account for two changes at once.

Hence the rules that look redundant until you ask what they prevent:

- **The list length must move by exactly ±1.** Otherwise `RemoveDelegate` could name one delegate
  while quietly stripping the rest, and the redeemer would still describe the transaction
  truthfully as far as it went.
- **No duplicate delegates.** A second entry for the same key could carry a later expiry,
  silently extending an authority that was meant to lapse.
- **No self-delegation.** It is meaningless while you are the owner — and it would survive a
  transfer of ownership as a lingering back door.
- **`AddDelegate` needs an upper validity bound.** A transaction with no upper bound could be
  included at any time, so it would prove nothing about the expiry still being in the future.

## The flow

1. **Create** the identity — an owner, no delegates.
2. Attempt an edit that also **moves value** — rejected.
3. Attempt **self-delegation** — rejected.
4. **Add a delegate**, then add a second.
5. Attempt to **remove one by name but strip both** — rejected.
6. **Revoke exactly the one named.**

Each rejection is a phase-2 evaluation failure, i.e. the validator ran and said no. A transaction
cardano-client-lib merely failed to *build* would look similar in the log but prove nothing.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles the validator to Plutus and runs the unit tests
./gradlew run     # executes the full flow on-chain
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

The backend defaults to Yaci DevKit on `:8080`. Point it elsewhere with:

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

The delegates are fresh accounts that never need funding — a delegate is only ever a key. Expiry
is anchored to chain time rather than the local clock.

## Tests

[`IdentityValidatorTest`](app/src/test/java/org/cardanofoundation/templates/IdentityValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM through `julc-testkit`.

Most cases are about what must *not* change: an edit that also rotates the owner, also moves
value, or also drops an unrelated delegate. Two are worth calling out:

- `removeMustDropTheNamedDelegate` — a removal that takes the list from two entries to one, but
  keeps the wrong one. The length check alone would wave it through.
- `cannotForkTheIdentity` — two continuing outputs would produce two identities sharing an
  address, each looking equally authentic.

## Gotchas worth knowing

**Records have no structural equality on chain.** `TransferOwner` must confirm the delegate list
is unchanged, which means comparing element by element rather than with `equals`.

**Don't use `IntervalLib.finiteUpperBound` for the expiry check.** It returns a `-1` sentinel when
the bound is unbounded, and comparing that as if it were a timestamp treats a missing bound as a
real deadline. This validator matches on `IntervalBoundType` directly and rejects anything that
is not `Finite`.
