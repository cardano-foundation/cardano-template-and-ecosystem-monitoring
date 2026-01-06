# Subscription Service Smart Contract (Aiken)

This project contains the on-chain validation logic for a decentralized subscription service on Cardano, written in **Aiken**.

## Overview

The smart contract acts as a non-custodial vault that holds subscriber funds and allows a merchant to collect payments periodically. It guarantees:

- **Merchants** can only collect the agreed fee after the period has elapsed.
- **Subscribers** can cancel and retrieve their remaining funds at any time.
- **Merchants** can close the subscription safely by returning funds to the subscriber.

## Validator Logic

The `subscription` validator manages the spending of the UTxO.

### 1. Collect

Allows the merchant to collect the subscription fee for the current period.

- **Checks:**
  - Transaction signed by `merchant`.
  - Current time (validity range) > `last_claim + period`.
- **Outputs:**
  - A new UTxO back to the script address.
  - `last_claim` updated to the current time verification.
  - Value decreased exactly by `fee` (in Lovelace).
  - All other assets (tokens/NFTs) preserved.

### 2. Cancel

Allows the subscriber to stop the subscription.

- **Checks:**
  - Transaction signed by `subscriber`.
- **Outcome:**
  - The UTxO is consumed. The subscriber controls the transaction, so they can direct funds back to their wallet.

### 3. Close

Allows the merchant to terminate the contract.

- **Checks:**
  - Transaction signed by `merchant`.
  - Must pay the `subscriber` the remaining value.
- **Outcome:**
  - Ensures the merchant cannot exit with the user's principal funds.

## Data Structures

### Datum (`SubscriptionDatum`)

The state stored on the UTxO.

```aiken
pub type SubscriptionDatum {
  merchant: VerificationKeyHash,   // The service provider
  subscriber: VerificationKeyHash, // The customer
  fee: Int,                        // Payment amount per period
  last_claim: Int,                 // Timestamp of last payment
  period: Int,                     // millisecond duration
}
```

### Redeemer (`SubscriptionAction`)

The action being performed.

```aiken
pub type SubscriptionAction {
  Collect // Merchant taking payment
  Cancel  // Subscriber withdrawing
  Close   // Merchant terminating
}
```

## specific usage

### Prerequisites

- [Aiken](https://aiken-lang.org/) v1.1.0+

### Build

```bash
aiken check
aiken build
```

### Test

```bash
aiken test
```
