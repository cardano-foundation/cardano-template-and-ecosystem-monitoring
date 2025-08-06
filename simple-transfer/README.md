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

