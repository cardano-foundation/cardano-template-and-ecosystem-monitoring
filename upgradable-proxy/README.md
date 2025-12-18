# Upgradable Proxy Smart Contract

A two-contract system implementing upgradable logic through proxy delegation using Cardano's atomic transactions. The proxy contract has a datum with a script hash and validates that spending transactions based on that script hash are part of the transaction and mints a token as proof of execution.

## 🌟 What is this Upgradable Proxy Pattern?

Traditional smart contracts are immutable once deployed, creating limitations for contract evolution:
- Logic bugs cannot be fixed without complete redeployment
- Feature updates require new contract addresses
- User interactions must migrate to new contract instances
- No mechanism for seamless contract improvements
- State migration between contracts is complex and risky

This upgradable proxy pattern provides **delegated execution** where a proxy contract stores an implementation script hash in its datum and validates that the implementation contract executes in the same transaction. To upgrade the "contract", the datum needs to be updated with the new script hash. Due to atomic transactions in Cardano, the spending validation of the referenced contract must succeed to make the proxy contract work and mint the delegation token.

## 🏗️ Architecture Overview

### Two-Contract Design

The upgradable proxy system implements delegation through two essential contracts:
- ✅ **Proxy Contract** - stores implementation script hash in datum and validates atomic execution
- ✅ **Logic Contract** - contains the actual business logic (withdraw zero pattern) that can be upgraded via the proxy datum
- ✅ Atomic transaction validation ensuring both proxy and implementation execute together
- ❌ No caller contract needed - users interact directly with the proxy

This design ensures that logic can be upgraded by updating the script hash in the proxy datum while maintaining the same proxy contract address. Any user wallet or dApp can interact directly with the proxy contract.

### 🚀 Running the example (Preprod)

This repository includes an off-chain script (`offchain/lucid-evolution/proxy.ts`) that demonstrates:

- creating/funding a wallet for the demo
- deploying/initializing the proxy instance (minting the “state token” and creating the proxy UTxO with an inline datum)
- minting a token via the proxy + logic contract path
- switching the logic contract version (upgrade/downgrade) by updating the proxy datum

This runs on **Cardano Preprod** using **Koios** as the provider.

#### Prerequisites

- Deno installed
- Some **tADA on Preprod** to fund the generated wallet (you’ll need enough for fees + collateral)
- Repo built so the following exist and are correct:
  - `onchain/aiken/plutus.json` (your compiled Aiken blueprint)
  - `offchain/lucid-evolution/types.ts` and `offchain/lucid-evolution/helper.ts` (used by `offchain/lucid-evolution/proxy.ts`)

#### 1) Prepare a demo wallet

Run:

    deno run -A offchain/lucid-evolution/proxy.ts prepare

What this does:

- Generates a new seed phrase (mnemonic)
- Selects it as the active wallet
- Writes the seed phrase to `offchain/lucid-evolution/wallet.txt`
- Prints the wallet address you must fund

What you should expect to see:

- `Successfully prepared wallet (seed phrase).`
- A wallet address printed in the output (send tADA to that address)

Notes / gotchas:

- The script writes secrets to disk (`offchain/lucid-evolution/wallet.txt`). Treat it like a private key.
- If `offchain/lucid-evolution/wallet.txt` already exists, the script intends to prevent overwriting (but see “Troubleshooting” below).
#### 2) Fund the wallet

Send some **tADA (Preprod)** to the printed address.

What to expect:

- Nothing else will work until the wallet has at least one UTxO with sufficient funds.
- If the next step fails saying no funds/UTxO found, wait for confirmation and try again.

#### 3) Initialize the proxy instance

Run:

    deno run -A proxy.ts init

What this does (high level):

- Finds a funded UTxO in your wallet and uses it as the **parameter (out-ref)** for the proxy script
- Builds the parameterized proxy validator and derives its policy id (script hash)
- Builds the parameterized logic validator (v1) using the proxy policy id
- Mints the “state token” under the proxy policy
- Creates a proxy UTxO at the proxy address containing:
  - the state token
  - an **inline datum** holding:
    - `script_pointer`: the script hash of the current logic validator
    - `script_owner`: your wallet payment key hash
- Registers a stake credential for the logic validator (certificate validator)

What you should expect to see:

- A success message plus a transaction link, similar to:
  - `Successfully setup a proxy contract pointing to ...`
  - `See: https://preprod.cexplorer.io/tx/<txHash>`
- The proxy script address printed:
  - `Proxy Script Address: <addr...>`
- The UTxO reference used as parameter:
  - `The utxo reference for this parameterized script is: <txHash>#<index>`
- An example mint command:
  - `Example usage: deno run -A offchain/lucid-evolution/proxy.ts mint <tokenUnit>`

**Important: token unit you will use next**  
The script prints an example like:

    deno run -A offchain/lucid-evolution/proxy.ts mint <tokenUnit>

That `<tokenUnit>` is the **state token unit** (policy id + token name) that identifies the proxy state UTxO. Keep it.

#### 4) Mint via the proxy (delegated execution)

Run:

    deno run -A proxy.ts mint <tokenUnit>

What this does:

- Locates the proxy state UTxO by `tokenUnit`
- Reads the proxy state datum to discover the currently active logic script hash
- Resolves which logic version to use (v1 or v2)
- Builds an atomic transaction that:
  - references the proxy script (minting policy)
  - mints `ProxyMintToken` under the proxy policy
  - executes a reward withdrawal from the logic script (0 lovelace) using the appropriate redeemer for v1/v2

What you should expect to see:

- `Using proxy policy ID: <policyId>`
- `Successfully minted a token under policy <policyId> using minting logic version <1|2>.`
- `See: https://preprod.cexplorer.io/tx/<txHash>`

If it fails with “No UTxO found for the provided token unit”, wait ~20 seconds and retry (indexing delay is common).

#### 5) Upgrade or downgrade the logic version

Run:

    deno run -A proxy.ts change-version <tokenUnit>

What this does:

- Finds the proxy state UTxO (by `tokenUnit`)
- Reads the current `script_pointer` from the datum
- Computes the “next” version (toggles v1 ↔ v2)
- Spends the proxy state UTxO and recreates it with an updated datum pointing to the next logic script hash
- Also executes the *current* logic script in the same transaction (withdrawal path) to satisfy the proxy’s delegated-validation requirement
- When upgrading from v1 → v2, it registers stake for the next logic validator (if your design requires it)

What you should expect to see:

- `... will now be upgraded to version (v2).` or `... will now be downgraded to version (v1).`
- A success message and tx link.

Note: when downgrading (v2 → v1), the script warns that stake registration remains on-chain and a re-registration might cause issues. That’s expected in this demo.

#### Troubleshooting

- **No UTxO with enough funds found**
  - Fund the wallet address printed in `prepare`. Wait for confirmation on Preprod and retry.

- **No UTxO found for the provided token unit**
  - Usually indexing delay. Wait ~20 seconds and retry.

- **Wallet prepare logic note**
  - The message about `wallet.txt` “already exist” may appear due to an inverted condition in the script. If you see confusing behavior, check whether `wallet.txt` is present and remove it if you want a fresh wallet.

#### Command summary

    deno run -A proxy.ts prepare
    deno run -A proxy.ts init
    deno run -A proxy.ts mint <tokenUnit>
    deno run -A proxy.ts change-version <tokenUnit>

## 🤝 Contributing

This smart contract serves as an educational example of contract evolution patterns on Cardano. Contributions, improvements, and discussions are welcome!

## ⚠️ Disclaimer

This is an educational project demonstrating contract evolution capabilities on Cardano. Since Cardano validators are immutable, this pattern provides version management rather than true upgradability. Always audit version management mechanisms thoroughly before using in production. Ensure proper governance and security reviews for all contract versions. Consider the limitations of version-based evolution carefully.