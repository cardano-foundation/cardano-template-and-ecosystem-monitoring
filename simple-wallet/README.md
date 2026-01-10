# Simple Wallet

This repository implements the **Simple Wallet** use case as defined in the Rosetta specification.

The Simple Wallet acts as a native ADA deposit contract. The owner can create payment intents, execute them to transfer funds to a recipient, and withdraw the entire balance at any time.

The implementation is split into **on-chain contracts (Aiken)** and **off-chain transaction construction (MeshJS + Deno)**.

---

## Supported Actions

The Simple Wallet contracts support the following actions:

* **deposit** – add funds to the funds script address
* **createTransaction** – store a payment intent specifying recipient, value, and data at an intent script address
* **executeTransaction** – execute a stored payment intent if sufficient funds exist at the funds script
* **withdraw** – withdraw the entire balance from the funds script address (owner only)

Selection of which payment intent to execute is handled **off-chain**.

---

## 📄 On-chain

---

The on-chain logic is implemented in Aiken using three validators:

* **Wallet (minting policy)**
  Controls minting and burning of the `INTENT_MARKER` token, ensuring payment intents are explicitly created and later consumed.
  Double-spends are prevented by requiring the intent marker to be burned when its corresponding payment is executed.

* **Payment Intent**
  Locks a UTxO containing a `PaymentIntent` datum (recipient, amount, data).
  Can only be spent by a transaction signed by the owner.

* **Funds**
  Holds the wallet’s ADA balance and enforces correct execution of payment intents as well as owner-authorized withdrawals.

See `onchain/` for validator code, build instructions, and tests.

---


## 📄 Off-chain

### MeshJS (Deno)

Off-chain code uses **MeshJS** with **Deno** to construct and submit transactions that interact with the on-chain contracts.

#### Commands

```sh
deno run -A wallet.ts create-intent <wallet.json> <recipient> <lovelace> <data>
deno run -A wallet-cli-test.ts add-funds <wallet.json> <lovelace>
deno run -A wallet.ts execute <wallet.json>
deno run -A wallet.ts withdraw <wallet.json>
```

---

## Example Flow

### 1. Create a payment intent

```sh
deno run -A wallet-cli-test.ts create-intent wallet_0.json \
  "addr_test1qqejx57pyvd8dsv6nf75fm6z2f6euhlt5mymkyaycw9wwykqyc88c2p7g4rfprsxm4u208zevvj7h0v5ymjsjkyyzjdse26srh" \
  10000000 \
  "credit-note"
```

Output:

```
Intent address: addr_test1wpfq0vmuw9jjd0hsc4wpnuj8jle8m4j4wzt46r3l5g8nlgg9446xt
✅ Intent created: Tx Id: 8ba635005a179b7da121e0a1c50c787dd81c1351406563176ca528f9c63c8038
```

---

### 2. Fund the wallet

```sh
deno run -A wallet-cli-test.ts add-funds wallet_0.json 15000000
```

```sh
deno run -A wallet-cli-test.ts add-funds wallet_0.json 20000000
```

Output:

```
Funds address: addr_test1wqmuptvkl8xvllzfyet3d48dehgrp6etggewza7nrydtnrcj9xjaz
✅ Funds script funded: Tx Id: f3f04d20848bf734ed3e5443a5edbed5fb07e4a24fb3c35704785c91ba37368d
```

---

### 3. Execute the intent

```sh
deno run -A wallet-cli-test.ts execute wallet_0.json
```

Output:

```
✅ Intent executed: Tx Id: 190faabfe65bf415c2acea700fb623c77d10e3efee6465cf961ee556053d0248
```

---

### 4. Withdraw all funds

```sh
deno run -A wallet-cli-test.ts withdraw wallet_0.json
```

Output:

```
✅ Withdraw executed: Tx Id: 067b1fce4f7ae85e23fd45ccd9e38c32ab7673370140a962b257f77277cd8d51
```

---

## Notes

* All critical actions require the **owner’s signature**.
* Payment intents are stored using **inline datums**.
* Funds are held at a dedicated **funds script address**.
* Intent selection and execution orchestration are handled **off-chain**.

---
