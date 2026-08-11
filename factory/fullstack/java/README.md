# Factory — Java fullstack

On-chain **and** off-chain in one Java project. The validators are written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: the same three
validators with the same parameters in the same order, and the same datum and redeemer shapes.

## What this example shows

A factory that authorises products, and can prove which ones it authorised. Anyone can check
from the chain alone that a given product was created by a given factory — no off-chain index,
no trusted operator.

## Three scripts, one guarantee

| Class | Kind | Job |
| --- | --- | --- |
| [`FactoryMarkerValidator`](app/src/main/java/org/cardanofoundation/templates/validator/FactoryMarkerValidator.java) | mint | one-shot policy; mints the marker NFT that **is** the factory's identity |
| [`FactoryValidator`](app/src/main/java/org/cardanofoundation/templates/validator/FactoryValidator.java) | spend | carries the marker forward and records each product it authorises |
| [`ProductValidator`](app/src/main/java/org/cardanofoundation/templates/validator/ProductValidator.java) | mint + spend | refuses to mint unless the factory is spent in the same transaction |

A julc project can hold as many validators as it needs — each is its own class with its own
`@Entrypoint`, and `javac` emits a single CIP-57 blueprint covering all three.

The interesting part is that **no script trusts another**. The product's mint rule requires the
factory to be spent; spending the factory runs the factory's rule, which requires the new product
to be recorded in its datum. A transaction cannot satisfy one without satisfying the other, so
the authorisation chain holds without either script having to take the other's word for anything.

Uniqueness comes from the seed UTxO, not from counting. A UTxO can be spent exactly once, so once
the marker is minted the policy can never run again — and because the seed is a *parameter*, the
policy id itself differs per factory, so two factories can never share a marker.

## The parameter chain

Scripts are compiled and parameterised in dependency order, each one's hash feeding the next:

```java
markerPolicy = load(FactoryMarkerValidator.class, ownerKeyHash, seedUtxo);
factory      = load(FactoryValidator.class,       ownerKeyHash, markerPolicy.getPolicyId());
product      = load(ProductValidator.class,       ownerKeyHash, markerPolicy.getPolicyId(), productId);
```

There is no circularity: the factory is identified by the *marker policy*, not by its own address,
so the product script can name the factory without the factory needing to name the product.

## The flow

1. **Open the factory** — mint the marker against the seed UTxO, park it at the factory address
   with an empty product list.
2. Attempt to **mint a product without spending the factory** — rejected. This is the case the
   whole design exists to prevent: no factory spent means no chance for the factory to record it.
3. Attempt to **create a product without recording it** in the new datum — rejected by the
   factory script (the node reports the failure against `"purpose": "spend"`).
4. **Create the product properly** — the marker carries over, the product is minted, the datum
   grows by one entry.

Steps 2 and 3 are what make step 4 meaningful. A creation that merely succeeded would also
succeed if the authorisation rules were missing entirely.

Each rejection is reported as a phase-2 evaluation failure, i.e. the validator ran and said no.
A transaction cardano-client-lib merely failed to *build* would look similar in the log but prove
nothing.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles all three validators to Plutus and runs the unit tests
./gradlew run     # executes the full flow on-chain
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

The backend defaults to Yaci DevKit on `:8080`. Point it elsewhere with:

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

## Tests

[`FactoryValidatorTest`](app/src/test/java/org/cardanofoundation/templates/FactoryValidatorTest.java)
evaluates all three **compiled** scripts on a real Plutus VM through `julc-testkit`, with
parameters applied exactly as they are on-chain.

One builder produces the CreateProduct transaction, and each test bends a single field. Because
the factory spend and the product mint read the *same* transaction from different angles, that
builder emits two contexts — `spending(...)` and `minting(...)` — over one shared body. The
purpose is what decides where `ownHash` points, so evaluating a mint against a spending context
silently measures the wrong script.

The cases worth calling out are the ones about the marker: losing it would end the factory, and
producing *two* marker outputs would fork it into two histories that each look authentic.
Requiring exactly one continuing output rules out both.

## Gotchas worth knowing

**Shared code belongs in an `@OnchainLibrary`.** Each validator compiles to its own script, so
helpers reached across validator classes would otherwise be duplicated by hand — and a constant
like the marker name has to be byte-identical everywhere or the scripts stop recognising each
other's tokens. [`FactoryLib`](app/src/main/java/org/cardanofoundation/templates/validator/FactoryLib.java)
holds them.

**julc inlines library *methods* across validators, but not static *fields*.** A `static final
byte[] MARKER_NAME` read from another class fails to lower with `Undefined variable`. Exposing it
as `markerName()` works.

**Only the no-arg `"NAME".getBytes()` lowers.** `getBytes(StandardCharsets.UTF_8)` fails with
`Undefined variable: StandardCharsets`, and a `byte[]{...}` array literal fails outright.
