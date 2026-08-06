# Atomic Transaction — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

## What this example shows

A Cardano transaction runs **every** script it touches before **any** of its effects apply.
There is no partial execution, and you do not have to build that guarantee yourself.

[`AtomicTransactionValidator`](app/src/main/java/org/cardanofoundation/templates/validator/AtomicTransactionValidator.java)
puts two entrypoints of deliberately mismatched strictness in one script:

| Entrypoint | Rule |
| --- | --- |
| `spend` | accepts anything |
| `mint` | requires `super_secret_password` in the redeemer |

[`App`](app/src/main/java/org/cardanofoundation/templates/App.java) then uses both in a single
transaction. Because the strict mint runs alongside the permissive spend, a wrong password
cancels the spend too — even though the spend itself would have succeeded.

## The flow

1. **Lock** 10 ADA at the script address, so the spend entrypoint has something to unlock.
2. **Attempt** spend + mint with the *wrong* password. The transaction is rejected, and the
   locked UTxO is still there — this is the atomicity, observed rather than asserted.
3. **Repeat** with the correct password. Both operations commit together.
4. **Verify** the confirmed transaction lists an input at the script address, proving the
   spending validator actually ran.

Step 4 is deliberately fail-closed. Checking that the UTxO merely *disappeared* would pass by
accident any time the lookup itself failed.

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

[`AtomicTransactionValidatorTest`](app/src/test/java/org/cardanofoundation/templates/AtomicTransactionValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM through `julc-testkit`, so the tests
exercise the same UPLC the chain would execute rather than the Java source.

## A julc gotcha worth knowing

Read record components through their accessor (`redeemer.password()`), never as a bare field
(`redeemer.password`). Plain `javac` accepts the direct read, but julc lowers accessors only and
fails with `Plutus compilation error: Unbound variable: password`.
