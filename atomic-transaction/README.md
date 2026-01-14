# ⚛️ Atomic Transaction

This smart contract demonstrates Cardano's native atomic transaction guarantees. In this example, we build a transaction that executes two validator operations simultaneously: spending from a script (with a validator that always returns `true`) and minting a token (with a validator that requires a password). This showcases how Cardano transactions are atomic by design - all operations either succeed together or fail together.

## 🌟 What are Atomic Transactions?

Atomic transactions are transactions where all operations either complete successfully together or fail together - there is no partial execution. On Cardano, **all transactions are inherently atomic** by the protocol design. This is a fundamental property of the UTXO model and Cardano's transaction execution engine.

This example demonstrates this atomicity by:
- Combining a spending validator (always returns `true`) with a minting validator (requires password)
- First attempting the transaction with a **wrong password** - the entire transaction fails even though the spending validator passes
- Then attempting with the **correct password** - both validators pass and the entire transaction succeeds

This proves that even though the spending validator would individually succeed, the transaction as a whole fails if any part fails.

## 🏗️ Example Architecture

This example includes two validators in a single script:

### Spending Validator
```aiken
spend(_datum, _redeemer, _utxo, _self) {
    True  // Always allows spending
}
```
- Always returns `true`
- Would succeed on its own
- Demonstrates that a passing validator doesn't guarantee transaction success

### Minting Validator
```aiken
mint(redeemer: MintRedeemer, _policy_id, _self) {
    redeemer.password == "super_secret_password"
}
```
- Requires the correct password
- When this fails, it causes the entire transaction to fail
- Demonstrates atomic failure propagation

## 🔄 Transaction Flow

### Step 1: Lock Funds
Fund the script address with ADA, creating a UTXO that can be spent (the spending validator always allows it).

### Step 2: Attempt with Wrong Password
Build a transaction that:
- Spends from the script UTXO (validator returns `true`)
- Attempts to mint a token with wrong password (validator returns `false`)

**Result**: The entire transaction fails, even though the spending validator passed. This demonstrates atomicity.

### Step 3: Execute with Correct Password
Build a transaction that:
- Spends from the script UTXO (validator returns `true`)
- Mints a token with correct password (validator returns `true`)

**Result**: Both validators pass, the transaction succeeds, and both operations complete atomically.

## ⛓ On-chain

### Aiken

#### 🔌 Prerequisites

- [Aiken](https://aiken-lang.org/installation-instructions#from-aikup-linux--macos-only)

#### 🪄 Test and build

```zsh
cd onchain/aiken
aiken check
aiken build
```

## 📄 Off-chain

### Java Cardano Client Lib
This offchain code is written using the [Cardano Client Lib](https://github.com/bloxbean/cardano-client-lib).
It assumes that the addresses are topped up. If you need some tAda, you can get some from the [Cardano Testnets Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/).

To simplify execution, all the code is contained in a single file, which can be run using `jbang`.

#### Prerequisites

Before running the code, ensure you have the following tools installed:

##### 1. Install JBang
You can install JBang using various methods:

- Using **SDKMAN**:
    ```shell
    sdk install jbang
    ```

- Using **cURL**:
    ```shell
    curl -Ls https://sh.jbang.dev | bash -s - app setup
    ```

For other installation methods, refer to the [JBang installation guide](https://www.jbang.dev/download/).

**Note:** If Java is not installed on your machine, JBang will download a Java runtime for you.

##### 2. Install and Start Yaci DevKit
You need to download and start the Yaci DevKit. This can be done using either the Docker version or the NPM distribution.

###### a. Docker Version:
Follow the instructions [here](https://devkit.yaci.xyz/yaci_cli_distribution).

After installing Yaci Devkit Docker distribution, you can start DevKit in non-interactive mode in just one command:

```shell
devkit start create-node -o --start
```

###### b. NPM Distribution:
Follow the instructions [here](https://devkit.yaci.xyz/yaci_cli_npm_distr).

**Important:**  
When starting the Yaci DevKit using NPM distribution, be sure to include the `--enable-yaci-store` option with the `up` command.

#### Running the Code

To run the code, use the following command from the repository root:

```shell
jbang atomic-transaction/offchain/atomicTransaction.java
```

This command will execute the `main` method, which performs the following steps:
1. Funds the script address with ADA
2. Attempts to spend and mint with an incorrect password (transaction fails)
3. Attempts to spend and mint with the correct password (transaction succeeds)

## Verify the Output

After running the code, you can verify the output in Yaci Viewer. To access Yaci Viewer in docker distribution, use the following url:

```html
http://localhost:5173
```

The output should show:
- First transaction fails (wrong password) despite the spending validator passing
- Second transaction succeeds (correct password) with both operations completing

## 🎯 Key Takeaway

This example demonstrates that **Cardano transactions are atomic by design**. You don't need special mechanisms or additional logic to ensure atomicity - it's a fundamental guarantee of the protocol. When building complex transactions with multiple validator executions, you can rely on this property to ensure consistent state transitions.


## 📄 Off-chain (MeshJS – Deno)

This repository also includes an alternative off-chain implementation using **MeshJS**, written in **TypeScript** and executed with **Deno**.

The MeshJS implementation demonstrates the same atomic transaction guarantees as the Java example, using a single orchestrated off-chain flow.

### 📁 Location

```text
atomic-transaction/offchain/meshjs
```

---

### 🔌 Prerequisites

Ensure the following are available:

* [Deno](https://deno.land/)
* A running Cardano devnet or testnet (for example via Yaci DevKit)
* A wallet JSON file funded with test ADA

Wallet files are expected to contain signing keys compatible with MeshJS.

---

### ▶️ Running the MeshJS Off-chain Code

Navigate to the MeshJS off-chain directory:

```shell
cd atomic-transaction/offchain/meshjs
```

All commands below are executed from this directory.

---

## 🧪 Example Flow (MeshJS)

The MeshJS off-chain code executes the full atomic transaction flow in a **single function**, coordinating multiple on-chain steps.

### Step 1: Mint and Lock (Setup)

* A token is minted using an **always-success minting policy**
* The minted token and some ADA are locked at the **atomic script address**
* This step is purely setup and does **not** involve password validation

```shell
deno run -A atomic-transaction.ts run wallet_0.json
```

Sample output:

```text
Step 1: Minting (always success) and locking at script
Setup tx submitted: <tx-hash>
```

---

### Step 2: Wait for Chain Confirmation

The off-chain code waits until the script UTXO appears on-chain before continuing:

```text
Script UTxO found
```

This ensures the next transaction is built against confirmed chain state.

---

### Step 3: Atomic Spend + Password-Gated Mint

A **single transaction** is constructed that:

* Spends the script UTXO (the spending validator always returns `true`)
* Mints a token using the password-gated minting validator
* Uses `"super_secret_password"` as the mint redeemer

Because Cardano transactions are atomic:

* If the password is **incorrect**, the entire transaction fails
* If the password is **correct**, both the spend and mint succeed together

Sample output on success:

```text
Atomic transaction submitted: Tx hash: <tx-hash>
```

---

## 🔍 Verification

The transactions can be inspected using:

* Yaci Viewer (for local devnet)
* Any Cardano explorer compatible with the chosen testnet

You should observe:

* A setup transaction creating a script-locked UTXO
* A single atomic transaction that both spends the UTXO and mints the token

---

## 🎯 MeshJS Takeaway

This MeshJS example demonstrates that **Cardano’s atomicity guarantees apply regardless of tooling**.

Even though the spending validator always succeeds, the final outcome of the transaction is governed by the minting validator. When multiple validators execute within a single transaction, **all must pass or none take effect**—a core property of Cardano’s eUTxO model.
