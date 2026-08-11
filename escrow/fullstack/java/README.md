# Escrow — Java fullstack

On-chain **and** off-chain in one Java project. The validator is written in plain Java and
compiled to Plutus V3 by [julc](https://github.com/bloxbean/julc) during `javac`; the
transactions are built with [cardano-client-lib](https://github.com/bloxbean/cardano-client-lib).

This is a port of [`onchain/aiken`](../../onchain/aiken) and keeps its datum, redeemer and rules.

## What this example shows

A two-party asset swap with no arbitrator. Neither side has to trust the other, and neither
can walk away with the other's funds.

```
  Initiation      initiator has locked their side
       │  RecipientDeposit — recipient puts up theirs and is named in the datum
       ▼
  ActiveEscrow    both sides committed
       │  CompleteTrade — both sign, bundles cross over
       │  CancelTrade   — unwind, each side gets their own deposit back
       ▼
     settled
```

| Redeemer | Who may call it | What it enforces |
| --- | --- | --- |
| `RecipientDeposit` | anyone | the recipient's bundle is actually added, and the initiator's terms are carried over untouched |
| `CompleteTrade` | both parties | **both** signatures, and the bundles cross over |
| `CancelTrade` | initiator, or either party once active | before opt-in, the initiator alone; after, **both** deposits must go home |

`RecipientDeposit` needs no signature on purpose. The redeemer names the recipient and the value
check forces whoever submits it to put up that side, so there is nothing to gain by submitting
it for someone else.

## Guarding against double satisfaction

Every branch requires **exactly one input from the script**. A validator runs once per script
input, and each run sees the same outputs — so without that check, one transaction could spend
two escrow UTxOs while paying out only enough to satisfy one of them.
`completeFailsWithASecondScriptInput` covers this.

## The flow

1. **Fund** the recipient, who starts empty and must deposit their own side.
2. **Lock** the initiator's 10 ADA under an `Initiation` datum.
3. **Deposit** the recipient's 15 ADA, moving the escrow to `ActiveEscrow`.
4. Attempt settlement with **only the initiator's signature** — rejected.
5. **Settle** with both signatures; each party receives the other's side.
6. **Cancel** a fresh escrow the recipient never joined.

Step 4 is what makes the two-signature rule visible. A passing settlement alone would prove
nothing, since it would also pass if the rule were missing.

## Why the escrow carries a fee buffer

The escrow holds 3 ADA more than the traded bundles. Without it the settlement cannot balance:
the script input would exactly equal the two payouts, leaving nothing for the fee, and
cardano-client-lib takes the fee out of a payee's output — leaving that party short of what the
datum promises them, which the validator then correctly rejects.

The datum still states only the traded amounts, so the buffer is invisible to the contract's
rules. This is worth knowing generally: **never make the fee payer a payee of an exact amount**
a validator checks.

## Running it

Needs a running [Yaci DevKit](https://devkit.yaci.xyz/) and JDK 25.

```shell
./gradlew build   # compiles the validator to Plutus and runs the unit tests
./gradlew run     # executes the full lifecycle on-chain
```

`run` exits non-zero if any step fails, so it doubles as the CI check.

The backend defaults to Yaci DevKit on `:8080`. Point it elsewhere with:

```shell
CARDANO_BACKEND_URL=http://localhost:9080/api/v1/ ./gradlew run
```

## Tests

[`EscrowValidatorTest`](app/src/test/java/org/cardanofoundation/templates/EscrowValidatorTest.java)
evaluates the **compiled** validator on a real Plutus VM through `julc-testkit`, covering every
branch plus the attacks each rule exists to stop: underpaying the deposit, rewriting the
initiator's terms, settling with one signature, cancelling while keeping the other party's
deposit, and double satisfaction.

## Three julc gotchas worth knowing

**Use pattern-matching `switch`, not `instanceof`.** julc lowers `case ActiveEscrow active ->`
but rejects `x instanceof ActiveEscrow active` with `Undefined variable`.

**Do not name a pattern variable after a method.** Java keeps variables and methods in separate
namespaces, but julc does not: a variable named `deposit` shadows a method `deposit(...)`, and
the call is lowered as an attempt to apply the variable, failing at evaluation with
`Non-functional application`.

**Cast an inline datum through `Object`.** `OutputLib.getInlineDatum` returns `PlutusData`; on
chain that is the same bytes as your datum type, but javac cannot know, so
`(EscrowDatum) (Object) ...` is needed — the same idiom julc's own stdlib uses.
