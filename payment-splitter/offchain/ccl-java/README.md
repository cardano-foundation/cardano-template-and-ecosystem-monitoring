# Payment Splitter - Offchain Code in Java using Cardano Client Lib (CCL)

This repository provides an example of how to use the Cardano Client Lib (CCL) to create offchain code for payment splitter in Java.  
The payment splitter is a smart contract designed to split payments between multiple recipients.

To simplify execution, all the code is contained in a single file, which can be run using `jbang`.

## Prerequisites

Before running the code, ensure you have the following tools installed:

### 1. Install JBang
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

### 2. Install and Start Yaci DevKit
You need to download and start the Yaci DevKit. This can be done using either the Docker version or the NPM distribution.

#### a. Docker Version:
Follow the instructions [here](https://devkit.yaci.xyz/yaci_cli_distribution).

After installing Yaci Devkit Docker distribution, you can start DevKit in non-interactive mode in just one command:

```shell
devkit start create-node -o --start
```

#### b. NPM Distribution:
Follow the instructions [here](https://devkit.yaci.xyz/yaci_cli_npm_distr).

**Important:**  
When starting the Yaci DevKit using NPM distribution, be sure to include the `--enable-yaci-store` option with the `up` command.

## Running the Code

To run the code, use the following command:

```shell
jbang PaymentSplitter.java
```

This command will execute the `main` method, which performs the following steps:
1. Creates the required accounts in the `init()` method.
2. Locks the funds in the contract address using the `lock()` method.
3. Unlocks the funds and distributes them to the recipients using the `unlock()` method.

## Verify the Output

After running the code, you can verify the output in Yaci Viewer. To access Yaci Viewer in docker distribution, use the following url

```html
http://localhost:5173
```
