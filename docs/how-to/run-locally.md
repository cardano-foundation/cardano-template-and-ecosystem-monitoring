# How to run the test matrix locally

Goal: reproduce the CI matrix on your laptop so you can iterate without pushing.

## Prerequisites

- **Yaci DevKit** (the local Cardano test runtime). Install via npm:
  ```sh
  npm install -g @bloxbean/yaci-devkit@$(grep '^yaci_devkit:' versions.yml | cut -d'"' -f2)
  ```
  (The version pin matches `versions.yml`; bump only when the file does.)
- **Aiken** (the onchain compiler). Install via aikup:
  ```sh
  curl --proto '=https' --tlsv1.2 -LsSf https://install.aiken-lang.org | sh
  source $HOME/.aiken/bin/env
  aikup install "v$(grep '^aiken:' versions.yml | cut -d'"' -f2)"
  ```
- **Deno** (for Mesh.js + Lucid Evolution offchain examples). Install with the version in `versions.yml`:
  ```sh
  curl -fsSL https://deno.land/install.sh | sh -s "v$(grep '^deno:' versions.yml | cut -d'"' -f2)"
  ```
- **JBang + JDK 24** (for `ccl-java` examples). [Install JBang](https://www.jbang.dev/download/) and a JDK 24 (Temurin works).

If you only care about a subset of frameworks, skip the runtimes you don't need.

## Step 1: discover what's there

```sh
scripts/local-test-discovery.sh
```

The script lists every registered framework (from `frameworks/*.yml`), walks every use-case manifest, and writes per-framework lists into `.local-test-results/`. If a use-case directory exists without a manifest, the script errors with a clear message — every use case is required to ship an `example.yml`.

## Step 2: start Yaci DevKit (if you'll run any offchain example)

In a separate terminal:

```sh
yaci-devkit up --enable-yaci-store
```

Wait for `localhost:8080` to come up (the Blockfrost-compatible endpoint).

## Step 3: run the cells you care about

For onchain Aiken examples:

```sh
cd <use-case>/onchain/aiken
aiken check && aiken build
```

For offchain examples (uses the descriptor-driven runner):

```sh
scripts/ci/run-cell.sh <use_case> <framework>
# e.g.
scripts/ci/run-cell.sh atomic-transaction meshjs
scripts/ci/run-cell.sh simple-transfer ccl-java
```

The runner reads `frameworks/<framework>.yml` for the actual command, resolves the entry file from `<use-case>/example.yml`, runs the cell from the right working directory, and writes a `result.json` plus a log file to `.ci-results/`.

## Step 4: aggregate and render

```sh
scripts/aggregate-results.sh .ci-results matrix.json
scripts/render-matrix.sh matrix.json | less
```

You'll see the same per-cell pass/fail table that the CI workflow renders to its step summary.

## Tips

- **Iterate on one cell at a time.** `scripts/ci/run-cell.sh <use_case> <framework>` always reads the descriptor and manifest fresh; a manifest edit is picked up on the next invocation.
- **Yaci's pre-funded wallet.** The well-known mnemonic `test test test test test test test test test test test test test test test test test test test test test test test sauce` controls the default genesis-funded address. Use it for tests that need ADA without a faucet round-trip.
- **Reset Yaci between runs.** `yaci-devkit reset` (or stop and restart) gives you a clean ledger if a previous test left state that's confusing your current one.
- **Mismatched aiken.toml `compiler =` field.** Aiken treats this field as a *minimum*. Newer installed Aiken compiles older toml claims fine. If you see a real version-mismatch error, bump the toml's `compiler =` field.

## When CI says red but local says green

Most likely: a tool version mismatch. The CI workflow installs the versions pinned in `versions.yml`; if your local install drifted, your local build is using a different version. Check with `aiken --version`, `deno --version`, `jbang version`, etc. against `versions.yml`.

Less common: a Yaci DevKit reset issue or a stale `.ci-results/` directory. Delete `.ci-results/` and re-run the cell.
