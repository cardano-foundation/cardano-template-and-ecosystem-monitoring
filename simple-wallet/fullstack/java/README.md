# Simple Wallet — Java fullstack

On-chain **and** off-chain in one Java project. The validators are written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its structure: the same three
validators with the same parameters in the same order, and the same datum and redeemer shapes.

## What this example shows

A smart-contract wallet that separates **what** to pay from **whether** to pay it.

An intent is published on chain first — recipient, amount, reference. It is a proposal anyone can
inspect, and it moves nothing. Executing it needs the owner's signature *as well*, pays out
exactly the intent, and burns the marker so the same intent can never run twice.

That split is the whole idea. Publishing a payment for review is safe precisely because review
and authorisation are different acts.

## Three scripts

| Class | Kind | Job |
| --- | --- | --- |
| [`PaymentIntentValidator`](app/src/main/java/org/cardanofoundation/templates/validator/PaymentIntentValidator.java) | spend | holds one pending intent; owner-only, so the owner can cancel |
| [`WalletValidator`](app/src/main/java/org/cardanofoundation/templates/validator/WalletValidator.java) | mint | mints/burns the `INTENT_MARKER` that binds an intent to this wallet |
| [`FundsValidator`](app/src/main/java/org/cardanofoundation/templates/validator/FundsValidator.java) | spend | the vault: `ExecuteTx` pays an intent exactly, `Withdraw` is an owner-only sweep |

Scripts are compiled and parameterised in dependency order, each hash feeding the next:

```java
intent       = load(PaymentIntentValidator.class, ownerKeyHash);
walletPolicy = load(WalletValidator.class,        ownerKeyHash, intent.getScriptHash());
funds        = load(FundsValidator.class,         ownerKeyHash, walletPolicy.getPolicyId());
```

A datum sitting at the intent script proves nothing on its own — anyone can build an output with
any datum. The **marker** is what makes an intent real, because only this wallet's policy can
mint one, and it only does so for an output that actually lands at the intent script carrying a
well-formed intent.

## Exactness is the rule

`ExecuteTx` requires the recipient to receive *exactly* the intent amount. Not "at least".

Overpaying is refused just as underpaying is, and that is deliberate: a surplus is a transfer the
owner never authorised, even though it looks generous. The example proves both directions on
chain, plus the case where the marker is not burned — which would leave the intent replayable.

## The flow

1. **Fund the vault** — a plain payment; the funds validator only runs on the way out.
2. **Publish an intent** — mint the marker, park it at the intent script with the payload.
3. Attempt to **overpay** — rejected. Attempt to **underpay** — rejected. Attempt to execute
   **without burning the marker** — rejected.
4. **Execute** — the vault and the intent are spent together, the recipient is paid exactly, the
   marker is burned.

The recipient is a separate account from the fee payer on purpose. Making the fee payer a payee
of an exact amount does not work: cardano-client-lib deducts the fee from that output, leaving
the party short of a figure the validator checks to the lovelace.

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

[`SimpleWalletValidatorTest`](app/src/test/java/org/cardanofoundation/templates/SimpleWalletValidatorTest.java)
evaluates all three **compiled** scripts on a real Plutus VM through `julc-testkit`.

The design's claim is that an intent and a signature are each necessary and neither is
sufficient, so the tests attack it from both sides. One case is there for a subtler reason:
`executionAcceptsASplitPayment` — a payment may legitimately arrive across several outputs, so
the validator sums them rather than looking for a single matching output.

## Gotchas worth knowing

**Types shared between validators must live in the `@OnchainLibrary`.** `PaymentIntent` is read
by all three scripts. Nested inside a validator class it fails to lower from the *others* with
`Unknown type: PaymentIntent`, because each validator is its own compilation unit. Moving it to
[`WalletLib`](app/src/main/java/org/cardanofoundation/templates/validator/WalletLib.java) fixes
it — the same boundary that applies to static fields.

**Recipient matching compares payment credentials.** Aiken compares the whole `Address`, staking
part included. This port compares the payment credential, consistent with the other examples
here. The practical difference is narrow — an output to the same payment key with a different
stake key still pays the intended party — but it is a real deviation, noted rather than hidden.
