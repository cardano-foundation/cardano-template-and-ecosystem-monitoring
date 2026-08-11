# Anonymous Data — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken).

## What this example shows

Commit to something now, prove it was yours later — without putting your identity on-chain in
the meantime.

| Purpose | What happens |
| --- | --- |
| **mint** (commit) | mint one token whose *asset name* is `blake2b_256(pubKeyHash ++ nonce)`, and park it at the script with the payload as an inline datum |
| **spend** (reveal) | spend that token, proving a signer can reconstruct the same digest |

Between commit and reveal the chain holds only a digest. Nobody can tell which key produced it,
and because the nonce is secret nobody can test a guess against the set of known keys either —
which is what a bare `blake2b_256(pubKeyHash)` would allow.

The commit is deliberately **unsigned**. Requiring a signature would put the committer's key in
the transaction and defeat the entire point.

## Reading the commitment from the token, not the redeemer

The reveal recovers the committed digest from the *asset name of the token in the UTxO being
spent*:

```java
byte[] committedId = ValuesLib.findTokenName(
        OutputLib.txOutValue(ownInput.resolved()), ContextsLib.ownHash(ctx), BigInteger.ONE);
```

Taking it from the redeemer instead would let a spender name whichever commitment they happen
to be able to open, rather than the one actually attached to the funds they are spending.
`revealFailsAgainstSomeoneElsesCommitment` covers this.

## The flow

1. **Commit** — mint the marker and store it with the payload.
2. Attempt a reveal **with the wrong nonce** — rejected by the validator.
3. **Reveal** with the correct nonce.

Step 2 is what makes the commitment binding visible. A successful reveal alone would prove
nothing, since it would also succeed if the digest check were missing.

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

## Tests

[`AnonymousDataValidatorTest`](app/src/test/java/org/cardanofoundation/templates/AnonymousDataValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM through `julc-testkit`: the commit
requires exactly one marker stored with a datum, and the reveal fails on a wrong nonce, a
different signer, or someone else's commitment.

## Three julc and CCL gotchas worth knowing

**A redeemer cannot be declared as a raw `byte[]`.** It looks tidier, and the unit tests even
pass — but on chain the redeemer already arrives as `Data` and julc's wrapper wraps it a second
time, aborting with `expected: bytestring; actual: data`. Take it as `PlutusData` and unwrap it
with `Builtins.unBData`. Note that `julc-testkit` calls the entrypoint directly and so bypasses
that wrapper, which is exactly why this class of bug only shows up in the on-chain run.

**A script spend needs an explicit output, not just a change address.** Without one,
cardano-client-lib never fills in the transaction body, so it cannot resolve the spend
redeemer's input index and fails with `Script utxo is not found in transaction inputs` — a
build error that is easy to mistake for a validator rejection. The marker is also a native
token, and native tokens cannot simply be dropped.

**`ContextsLib.ownHash` works for minting.** It returns the policy id under a minting purpose
and the script hash under a spending one, which is what lets this validator use the same call
in both entrypoints. (It does *not* work for withdrawal or certification purposes.)
