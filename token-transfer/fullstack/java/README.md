# Token Transfer — Java fullstack

On-chain **and** off-chain in one Java project. The validators are written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: the same three
parameters in the same order, and the same two branches.

## What this example shows

A delivery address for one specific token.

[`TokenTransferValidator`](app/src/main/java/org/cardanofoundation/templates/validator/TokenTransferValidator.java)
is parameterised on `(receiver, policy, assetName)`, so each address corresponds to exactly one
asset destined for exactly one person. Anyone may send that token there; only the receiver can
take it out.

## Two branches, and the second is not a bug

```java
if (!ValuesLib.containsPolicy(held, policy)) {
    return true;                  // escape hatch
}
return holdsTheAsset && receiverSigned && !routesOtherTokens(...);
```

A UTxO at this address that does **not** hold the target policy is dust or a mistaken transfer,
and anyone may retrieve it. That unconditional `true` looks alarming until you consider the
alternative: the guarded branch requires the named asset to be present, so a UTxO lacking it
could never satisfy any rule, and would be locked forever.

The boundary is narrower than it first appears. "Does not hold the target *policy*" is not the
same as "does not hold the target *asset*" — a **sibling asset under the same policy** still
takes the guarded branch, and then fails, because the named asset is absent. Both the unit test
`aSiblingAssetOfTheTargetPolicyIsStillGuarded` and the on-chain run pin this: the run mints its
stray token under a genuinely separate policy, because minting it under the same one produces a
UTxO nobody can move.

## The anti-batching rule

When the target asset *is* present, the receiver must sign — and no other token may leave the
script in that transaction.

This is about what a signature *means*. Signing should authorise collecting **this** delivery,
not act as blanket approval for whatever else a transaction builder decided to move in the same
breath. Outputs returning to the same address are ignored, because re-locking is not a departure,
and plain ada moves freely.

## The flow

1. **Mint** a delivery token and an unrelated one, both sent to the delivery address — the second
   as if by mistake.
2. Attempt to **collect without the receiver's signature** — rejected.
3. Attempt to **collect while sweeping the unrelated token away** — rejected.
4. The receiver **collects** their delivery.
5. The sender **retrieves** the mistakenly-sent token through the escape hatch, without being the
   receiver.

[`DemoTokenPolicy`](app/src/main/java/org/cardanofoundation/templates/validator/DemoTokenPolicy.java)
mints the assets. It is not part of the contract under test — the validator works with any asset
— and takes an index parameter purely so the example can produce two genuinely unrelated
policies.

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

The receiver is a separate account from the fee payer, so "the receiver signed" is a real
condition rather than something that happens automatically.

## Tests

[`TokenTransferValidatorTest`](app/src/test/java/org/cardanofoundation/templates/TokenTransferValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM, with the parameters applied exactly as
they are on chain.

The cases are grouped by branch, because the contract genuinely behaves in two different ways.
Three are there to stop a plausible misreading of the anti-batching rule: re-locking the asset is
allowed, a foreign token that *stays* at the script is allowed, and plain ada may always leave.
