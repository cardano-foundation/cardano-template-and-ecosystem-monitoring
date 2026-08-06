# Storage — Java fullstack

On-chain **and** off-chain in one Java project. The validators are written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: the same two
validators, the same datum and redeemer shapes, and the same rules in the same order.

## What this example shows

A verifiable audit registry. Publishing a snapshot mints an NFT and locks it at a script that
refuses every spend, so the entry becomes a permanent citation — nobody, including the
publisher, can revise or withdraw it afterwards.

The dataset itself never goes on chain. Only its SHA-256 commitment does, so anyone holding the
data can prove it matches, and anyone who does not learns nothing from the entry.

## Two validators, one system

| Class | Purpose | Job |
| --- | --- | --- |
| [`StorageMintValidator`](app/src/main/java/org/cardanofoundation/templates/validator/StorageMintValidator.java) | mint | enforces **every** rule |
| [`StorageValidator`](app/src/main/java/org/cardanofoundation/templates/validator/StorageValidator.java) | spend | returns `false`, always |

A julc project can hold as many validators as it needs — each is its own class with its own
`@Entrypoint`, compiled to its own script, and `javac` emits a single CIP-57 blueprint covering
both.

The split is what makes the design work. Because the spend validator never approves anything,
a registry UTxO can never be revisited, so **there is no second chance to validate it**.
Everything therefore has to be checked at mint time:

1. **The seed UTxO is spent.** It is a script parameter, so the policy has a different hash for
   every snapshot, and a UTxO can only be spent once. That makes each entry provably singleton
   rather than unique by convention.
2. **Exactly one token is minted**, named `sha2_256(snapshotId)`. The caller does not choose the
   name, so republishing an id collides on the token instead of quietly creating a rival record.
3. **It lands at the storage script.** An entry sitting in a wallet would be transferable, which
   defeats the permanence the whole design rests on.
4. **The datum restates the redeemer**, and is well-formed — a 32-byte commitment and a non-empty
   id.

## Parameters, not datum

```java
@Param static TxOutRef seedUtxo;
@Param static byte[] storageScriptHash;
```

The publishing order matters: `StorageValidator` takes no parameters, so it is compiled first
and its hash is fed into the policy as `storageScriptHash`. That is what lets the policy insist
on a destination it can name but does not itself control.

## The flow

`run` publishes one snapshot and then shows the three ways the design refuses to bend:

1. Publish with a datum that **disagrees with the redeemer** — rejected.
2. Publish the entry **to a wallet** instead of the registry — rejected.
3. Publish properly — succeeds, and the NFT is confirmed at the registry address.
4. Attempt to **spend** the published entry — rejected.

The refusals run *before* the successful publication and share its seed UTxO. A rejected
transaction is never submitted, so the seed survives — which means each refusal differs from the
success by exactly one variable. A refusal that passed for an unrelated reason would be worth
nothing.

Each rejection is reported by the node as `Error while evaluating script cost`, i.e. phase-2
evaluation ran and the validator said no. That is the outcome worth asserting: a transaction
cardano-client-lib merely failed to *build* would look similar but prove nothing.

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

## Tests

Both validators are evaluated as **compiled UPLC** on a real Plutus VM through `julc-testkit`,
with parameters applied exactly as they are on-chain.

[`StorageMintValidatorTest`](app/src/test/java/org/cardanofoundation/templates/StorageMintValidatorTest.java)
builds one valid publication and bends a single field per test, so each case names the rule it
is probing. [`StorageValidatorTest`](app/src/test/java/org/cardanofoundation/templates/StorageValidatorTest.java)
throws at the spend validator the cases a rule-based contract would normally wave through — the
rightful publisher, a signed transaction, a well-formed datum — because an always-false
validator is easy to get subtly wrong, and an accidental `true` branch would silently make every
published snapshot editable.

## Gotchas worth knowing

**A fail-closed check can fail closed on itself.** The backend model returns asset quantities as
`String`, so `BigInteger.ONE.equals(amount.getQuantity())` compiles cleanly and is silently
always false. The verification here compares strings. This is the same family of mistake as
asserting that a UTxO "disappeared": a check that can never pass looks identical to a check that
never fails.

**Sealed interfaces have no equality on chain.** `SnapshotType` is compared by mapping each
constructor to an index, mirroring Aiken's `snapshot_type_eq`.
