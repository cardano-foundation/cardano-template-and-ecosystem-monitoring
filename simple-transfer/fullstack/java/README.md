# Simple Transfer — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken).

## What this example shows

The smallest useful validator there is: hold funds until a named receiver signs. No datum, no
deadline, no redeemer.

```java
@Param static byte[] receiver;

@Entrypoint(purpose = Purpose.SPEND)
static boolean spend(PlutusData redeemer, ScriptContext ctx) {
    return ContextsLib.signedBy(ContextsLib.getTxInfo(ctx), receiver);
}
```

**Start here** if you are new to these examples — everything else in this repository is this
shape plus more conditions.

## Receiver as a parameter

The receiver is a validator **parameter**, so it is baked into the compiled script and changes
the script hash. Each receiver therefore has their own address, and the funds are addressed by
construction rather than by a datum a spending transaction might try to reinterpret.

The trade-off: the receiver is fixed when the script is created. Where you want one address
serving many independent arrangements, put the terms in the datum instead — see
[vesting](../../../vesting/fullstack/java).

## The flow

1. **Lock** 10 ADA at the receiver's script address.
2. The **sender tries to take it back** — rejected. Once sent, the funds are the receiver's.
3. The **receiver claims** them.

Step 2 is what makes the guarantee visible. A successful claim alone would prove nothing, since
it would also succeed if the signature check were missing.

The receiver never needs funding: it only signs, and the sender pays every fee.

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

[`SimpleTransferValidatorTest`](app/src/test/java/org/cardanofoundation/templates/SimpleTransferValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM through `julc-testkit`, applying the
receiver parameter exactly as it is applied on-chain: the receiver succeeds, a stranger fails,
an unsigned transaction fails, a key differing by one byte fails, and an extra co-signer is
harmless.

## A julc gotcha worth knowing

**Parameters must be `static` fields.** julc's own documentation shows `@Param` on instance
fields, but that does not compile: javac rejects reading an instance field from a static
entrypoint, and making the entrypoint an instance method hides it from `julc-testkit`, which
resolves entrypoints statically. Static fields satisfy both.
