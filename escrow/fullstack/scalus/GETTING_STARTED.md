# Getting Started

Standalone Scalus example, also available in the [scalus3/scalus](https://github.com/scalus3/scalus) monorepo.
Set up your Scala 3 Development environment: https://scalus.org/docs/get-started#install-scala-3-development-environment 

## Build

Compile the on-chain and off-chain sources:
	
```sh
sbt compile
```

## Test

Run all tests (unit + integration; uses the emulator backend).

```sh
sbt test
```

Test backends:

```sh
sbt test                           # in-memory emulator (the default)
SCALUS_TEST_ENV=emulator sbt test  # in-memory emulator, named explicitly
SCALUS_TEST_ENV=yaci sbt test      # a local Yaci DevKit node (auto-started; requires Docker)
```

## Profiling

Run the tests with on-chain execution profiling enabled. It writes an interactive HTML report (CPU and memory budget per source line) to target/profile.html

```sh
SCALUS_PROFILE=1 sbt test
```

## CIP-57 blueprints

`sbt package` embeds a CIP-57 blueprint JSON for every Contract in the JAR at
`META-INF/scalus/blueprints/<Contract>.json`. Run `sbt blueprint` to generate
without packaging — output goes to
`target/scala-3.3.8/resource_managed/main/META-INF/scalus/blueprints/<Contract>.json`.
Skip generation during `package` with `blueprint / skip := true` or `SCALUS_SKIP_BLUEPRINT=1`.

## Deploy as a reference script

Requires a Blockfrost project id and a funded wallet mnemonic on the chosen network.

```sh
sbt "deploy <ContractName> --network preview \
    --blockfrost-key <project-id> \
    --mnemonic '<24 words>'"
```

Or via environment variables:

```sh
export CARDANO_NETWORK=preview
export BLOCKFROST_API_KEY=<project-id>
export CARDANO_MNEMONIC='<24 words>'
sbt "deploy <ContractName>"
```

The contract is deployed as a reference script UTxO at the sender's own base
address; the transaction hash is printed on success.

## Pinned versions

- Scalus: `0.18.2`
- Scala:  `3.3.8`
- sbt:    `2.0.0`
