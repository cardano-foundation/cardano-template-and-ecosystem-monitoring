# How to add an implementation of an existing use case

Goal: implement an existing use case (e.g. `escrow`, `vesting`, `lottery`) in a registered framework that doesn't yet have an implementation, and have it appear as a new cell in the CI matrix.

## Prerequisites

- The framework you're targeting is already registered (`frameworks/<framework>.yml` exists). If not, run `scripts/scaffold-framework.sh` first — see [`add-framework.md`](add-framework.md).
- The use case has an `example.yml` manifest. Every use case in the repo does.

## Steps

### 1. Run the scaffolder

```sh
scripts/scaffold-use-case-implementation.sh \
    USE_CASE=<use_case> \
    KIND=<offchain|onchain> \
    FRAMEWORK=<framework>
```

For example:

```sh
scripts/scaffold-use-case-implementation.sh \
    USE_CASE=lottery \
    KIND=offchain \
    FRAMEWORK=ccl-java
```

The scaffolder:

- Validates that `frameworks/<framework>.yml` exists and that its `kind:` matches the `KIND` you passed.
- Creates the directory under `<use_case>/<onchain|offchain>/<framework>/` (refuses if it already exists — edit the existing implementation directly in that case).
- Drops a stub entry file with an extension picked from the descriptor's `default_entry` glob.
- Adds the implementation to the use case's `example.yml` manifest under the right section.

### 2. Replace the stub with a real implementation

Open the stub file (e.g. `lottery/offchain/ccl-java/Lottery.java`). The stub exits non-zero and prints "TODO: implement". Replace it with code that actually exercises the contract.

The CI workflow runs your file with no arguments via the framework's run command from the descriptor:

| Framework | Resolved command |
|---|---|
| `meshjs` / `lucid-evolution` | `deno run --allow-all <entry>.ts` |
| `ccl-java` | `jbang <Entry>.java` |
| `aiken` | `aiken check && aiken build` |

Your implementation needs to:

- Run the contract's happy path (or a representative subset) to completion.
- Exit non-zero if the contract behaves wrongly (throw `AssertionError` in Java; `Deno.exit(1)` in TypeScript; `aiken check` failure on Aiken).
- Optionally write a `result.json` to its working directory (the runner contract — see [`../design.md`](../design.md) "The result-json runner contract"). If you don't, the runner synthesizes one from the exit code.

For inspiration, look at the existing implementations of related use cases:

- Single-wallet, mint-and-spend: [`atomic-transaction/offchain/ccl-java/AtomicTransaction.java`](../../atomic-transaction/offchain/ccl-java/AtomicTransaction.java).
- Single-wallet, lock-and-claim: [`simple-transfer/offchain/ccl-java/SimpleTransfer.java`](../../simple-transfer/offchain/ccl-java/SimpleTransfer.java).
- Yaci wiring (Mesh.js): TBD — lands in P6 (real pilot tests milestone).
- Yaci wiring (Lucid Evolution): TBD — lands in P6.

### 3. Test it locally

Bring up Yaci DevKit and run your cell directly via the descriptor-driven runner:

```sh
yaci-devkit up --enable-yaci-store      # in a separate terminal
scripts/ci/run-cell.sh <use_case> <framework>
```

The runner reads `frameworks/<framework>.yml` and `<use_case>/example.yml`, runs the cell, writes `result.json` and a log file to `.ci-results/`.

### 4. Run discovery to confirm the cell is registered

```sh
scripts/local-test-discovery.sh
```

You should see your use case under "Manifest-mode discovery" with the new framework listed alongside its existing ones.

### 5. Push the branch

CI runs the new cell automatically.

## What just happened

You ran one scaffolder command, edited one source file, and pushed. The new cell appears in the matrix because:

- Discovery enumerated `frameworks/*.yml` and noticed your use case's manifest now declares the new framework.
- The workflow's offchain test job per use case dynamically iterated the manifest's declared offchain frameworks (or the onchain compile job picked up the new onchain entry) and invoked `scripts/ci/run-cell.sh` for each.
- The runner read the descriptor and the manifest, ran the command, and recorded the result.

No workflow YAML was edited, no discovery-script change was needed, and no scaffolder magic happened beyond copying a stub into place.

## Manual flow (without the scaffolder)

If `scripts/scaffold-use-case-implementation.sh` is unavailable or you want to do it by hand:

1. Create the directory: `mkdir -p <use_case>/<onchain|offchain>/<framework>/`.
2. Add an entry file. The descriptor's `default_entry` glob (e.g. `*.ts`) is the convention; the file's name is up to you.
3. Edit `<use_case>/example.yml` and add the entry to the appropriate section:
   ```yaml
   <kind>:
     <manifest_key>:
       path: <onchain|offchain>/<framework>
       entry: <your-file>
   ```
4. Verify with `scripts/local-test-discovery.sh`.
