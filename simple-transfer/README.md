# Simple transfer

This contract allows a user to deposit native assets define who can withdraw the assets. The receiver can then withdraw the assets. 

## ⛓ On-chain

### Aiken

#### 🔌 Prerequirements

- [Aiken](https://aiken-lang.org/installation-instructions#from-aikup-linux--macos-only)

#### 🪄 Test and build

```zsh
cd onchain/aiken
aiken check
aiken build
```

## 📄 Off-chain

### Java Cardano Client Lib 
This offchain code is written by using the [Cardano Client Lib](https://github.com/bloxbean/cardano-client-lib).
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

To run the code, use the following command:

```shell
cd offchain/ccl-java
jbang simple-transfer.java
```

## Verify the Output

After running the code, you can verify the output in Yaci Viewer. To access Yaci Viewer in docker distribution, use the following url

```html
http://localhost:5173
```

---

## 📄 Off-chain (MeshJS – Deno)

This repository also includes an alternative off-chain implementation using **MeshJS**, written in **TypeScript** and executed with **Deno**.

This implementation follows the same logical flow as the Java example:

* A sender deposits ADA at the script address
* A designated receiver (identified by payment key hash) is allowed to collect the funds

### 📁 Location

```text
simple-transfer/offchain/meshjs
```

---

### 🔌 Prerequisites

Ensure the following are available:

* [Deno](https://deno.land/)
* A running Cardano devnet or testnet (for example via Yaci DevKit)
* Wallet JSON files funded with test ADA

Wallet files (e.g. `wallet_0.json`, `wallet_1.json`) are expected to contain addresses and signing keys compatible with MeshJS.

---

### ▶️ Running the MeshJS Off-chain Code

Navigate to the MeshJS off-chain directory:

```shell
cd simple-transfer/offchain/meshjs
```

All commands below are executed from this directory.

---

## 🧪 Example Flow

### Alice deposits 20 ADA for Bob

Alice locks **20 ADA** at the script address and specifies Bob’s **payment key hash (PKH)** as the receiver.

```shell
deno run -A simple-transfer.ts deposit wallet_0.json <receiverPkh> 20000000
```

Example with a concrete PKH:

```shell
deno run -A simple-transfer.ts deposit wallet_0.json 332353c1231a76c19a9a7d44ef4252759e5feba6c9bb13a4c38ae712 20000000
```

#### Sample Output

```text
ADA locked at script
Receiver PKH: 332353c1231a76c19a9a7d44ef4252759e5feba6c9bb13a4c38ae712
Amount (lovelace): 20000000
TxHash: 8a8ae9bf2f76706fb61114007f05fbd0c1a62e42e4dbf35c68d01999db12b05b
```

---

### Bob collects the ADA using his wallet

Bob collects the locked ADA from the script using his wallet.

```shell
deno run -A simple-transfer.ts collect wallet_1.json
```

#### Sample Output

```text
ADA collected from script
Receiver PKH: 332353c1231a76c19a9a7d44ef4252759e5feba6c9bb13a4c38ae712
TxHash: 51c93f78c00424532778c9217e608f114ce31e99f4b36b19761b2bc9e2c5f911
```

---

### 🔍 Verification

The transactions can be inspected using:
* Any Cardano explorer compatible with preprod testnet
