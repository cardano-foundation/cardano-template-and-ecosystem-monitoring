# Adding a library to the cross-check

The cross-check matrix runs every Cardano use-case across **on-chain** languages
(Aiken, Scalus, …) × **off-chain** libraries (CCL-Java, Mesh.js, Evolution SDK,
PyCardano, …). This guide shows how to add a new framework with the **minimum**
work. The plumbing is config-driven: a new framework is one `frameworks.json`
entry — the local runner (`scripts/local-test-offchain.sh`) and CI
(`.github/workflows/ecosystem-test.yml`) pick it up automatically.

A third kind, **fullstack**, sits outside that cross-product: a fullstack example
carries its own on-chain validator *and* its own off-chain flow in one project, so
it is a single column rather than an axis. See
[Add a fullstack framework](#add-a-fullstack-framework).

## Add an off-chain library

### 1. Register it in `frameworks.json`

```jsonc
{
  "id": "mylib",
  "label": "My Lib",
  "kind": "offchain",
  "discoveryPath": "offchain/mylib/deno.json", // marker file (or *.ext glob) that flags an example as implemented
  "statusPrefix": "mylib",                      // used in status/log artifact names
  "subdir": "offchain/mylib",                   // dir under each example holding the entry file
  "entryGlob": "*.ts",                          // how to find the entry file
  "runtime": "deno",                            // deno | jbang | python (toolchain + run command)
  "versionFile": "offchain/mylib/deno.json",    // optional, for version sync
  "packages": ["my-sdk"]                         // optional, for version sync
}
```

`runtime` is the only thing the runner/CI dispatch on. If your library runs on an
**existing** runtime (`deno`/`jbang`/`python`), **no script or workflow changes
are needed**. A genuinely new runtime adds one `case` to `run_offchain()` and
`runtime_tool_ok()` in `scripts/local-test-offchain.sh`, and one conditional setup
step in `.github/workflows/_test-offchain.yml`.

### 2. Scaffold standalone skeletons

```bash
scripts/scaffold-offchain.sh mylib
```

This stamps a self-contained skeleton entry file into every example's
`offchain/mylib/` dir from `scripts/templates/offchain/<runtime>.*`. Each file is
standalone and copy-paste friendly — the boilerplate frame (blueprint loading,
yaci config) is written into the file, not imported from a shared library, so your
implementations stay idiomatic. Scope it with `--examples a,b,c` while iterating.

### 3. Implement the contract

Each entry file MUST:

1. **Read the `PLUTUS_JSON` env var** for the blueprint path, falling back to the
   example's local `onchain/aiken/plutus.json`. This is how the runner points one
   off-chain flow at different on-chain blueprints.
2. **Load the validator BY TITLE, not by array index.** Aiken titles look like
   `<module>.<validator>.<purpose>` (e.g. `auction.auction.mint`). Indexing
   `validators[0]` breaks silently if a blueprint lists validators in a different
   order. Use a title lookup with an index fallback.
3. **Run the use-case scenario** (the same lifecycle the other libraries run) and
   **exit non-zero on any failure** so the cross-check marks the combo red.

Conventions shared by all examples: yaci Blockfrost API at
`http://localhost:8080/api[/v1]`, and the standard devkit test mnemonic
(`test test … sauce`).

### 4. Run it

```bash
# one example while iterating
ONLY_FRAMEWORK=mylib ONLY_EXAMPLE=auction bash scripts/local-test-offchain.sh
# everything
bash scripts/local-test-offchain.sh && bash scripts/generate-dashboard.sh
```

In CI, the new framework appears in the discover job's `offchain-matrix` and is run
by the single matrix-driven `test-offchain` job — no workflow edits.

## Add an on-chain language

1. Register it in `frameworks.json` (`kind: "onchain"`, plus a `build` hint).
2. It must emit an **Aiken-shaped `plutus.json` blueprint**: validators titled
   `<module>.<validator>.<purpose>` matching the Aiken names off-chain code looks
   up, the same datum/redeemer schema, `plutusVersion`, `compiledCode` (single-CBOR
   wrapping the flat UPLC), and `hash`.
3. Add a `compile-<id>` job to `ecosystem-test.yml` (mirroring `compile-aiken`)
   and to `test-offchain`'s + `report-and-dashboard`'s `needs:`. Off-chain combos
   against the new language appear in `offchain-matrix` automatically.
4. In `scripts/local-test-offchain.sh`, add a `build_onchain()` case if the build
   command isn't already `aiken`.

> Scalus is **not** an on-chain framework here. It ships as a fullstack framework
> (`fullstack/scalus`), so it is one column rather than a cross-product axis.

## Add a fullstack framework

A **fullstack** example is self-contained: one project holding both the on-chain
validator and the off-chain flow that drives it. There is no blueprint to inject and
no on-chain language to vary, so it is **not** part of the off-chain × on-chain
cross-product — it renders as one column in its own "Fullstack" group.

`fullstack/java` (JulC + cardano-client-lib) is the reference implementation.

### 1. Register it in `frameworks.json`

```jsonc
{
  "id": "julc-java",
  "label": "JulC + CCL (Java)",
  "kind": "fullstack",
  "discoveryPath": "fullstack/java/settings.gradle", // marker file that flags an example as implemented
  "statusPrefix": "julc",                            // used in status/log artifact names
  "subdir": "fullstack/java",                        // dir under each example holding the project
  "runtime": "gradle",
  "versionFile": "fullstack/java/app/build.gradle",  // optional, for version sync
  "packages": ["cardano-client-lib", "julc"]
}
```

Discovery needs **no changes** — its per-framework loop is kind-agnostic and emits
`<statusPrefix>-examples.txt` automatically. The cross-product loop selects only
`onchain`/`offchain`, so a fullstack framework is naturally excluded from it.

### 2. Wire the CI job

Unlike off-chain frameworks, this part is not automatic, because each fullstack
framework has its own build tool:

1. Expose the example list as a `discover` output in `ecosystem-test.yml`
   (`julc-examples: ${{ steps.discovery.outputs.julc-examples }}`).
2. Add a `test-<id>` job pointing at `_test-fullstack.yml`.
3. Add that job to `report-and-dashboard`'s `needs`.
4. Add a `resolve_status <statusPrefix>` line to the status-reconstruct step.

`_test-fullstack.yml` itself is generic if your project builds with the Gradle
wrapper; a different build tool needs a new step there.

### 2b. Declare the verification bar

Not every fullstack framework can be held to the same standard, so each entry declares
what a green cell means:

| `verify` | What runs | What a green cell certifies |
| --- | --- | --- |
| `build+run` | build + unit tests, then the example against a devnet | the contract genuinely works on chain |
| `build` | build + unit tests only | it compiles and its unit tests pass |

`julc-java` is `build+run`. `scalus-fullstack` is `build` — those projects carry **no
runnable entrypoint**, so there is nothing to execute against a devnet. Read the two
columns accordingly: they are not equivalent evidence.

If you add an entrypoint to the Scalus examples, switch them to `build+run` and they
will be held to the higher bar automatically.

### 3. What each example must do

1. **Compile its validator** as part of `build`, and unit-test it against a real
   Plutus VM.
2. **Run the full use-case flow** on-chain against Yaci DevKit.
3. **Exit non-zero on any failure.** The exit code *is* the result — a green cell
   means the contract genuinely worked.
4. **Prove the validator ran**, fail-closed. Assert the confirmed transaction has an
   input at the script address (or the expected policy id / asset quantity for mints).
   Do not assert that a UTxO merely disappeared: that passes by accident whenever the
   lookup itself fails.
5. **Read `CARDANO_BACKEND_URL`**, defaulting to `http://localhost:8080/api/v1/`.

### 4. Status and artifact naming

Fullstack has no on-chain axis, so its names drop that segment:

| | off-chain | fullstack |
| --- | --- | --- |
| log artifact | `logs-<prefix>-<onchain>-<example>` | `logs-<prefix>-<example>` |
| status file | `<prefix>-<onchain>-<example>-status.txt` | `<prefix>-<example>-status.txt` |

`generate-dashboard.sh` strips fullstack prefixes in its own loop when recovering
use-case names. A new fullstack framework is picked up by that loop automatically
via `kind`, but **a status prefix that collides with an on-chain prefix will
mis-parse** — keep it distinct.

### 5. Run it

```bash
# one example while iterating
ONLY_EXAMPLE=htlc bash scripts/local-test-fullstack.sh
# everything
bash scripts/local-test-fullstack.sh && bash scripts/generate-dashboard.sh
```

Examples run sequentially on purpose: concurrent runs starve the single yaci-store
script-evaluation endpoint and produce spurious "Error while evaluating script cost"
failures that look like contract bugs.

## Safety gate (local runs)

Locally, a non-Aiken combo only runs if the off-chain source references
`PLUTUS_JSON` — otherwise it would re-test the default Aiken blueprint and report a
false positive. Following the contract above (step 3.1) satisfies this gate. CI
instead overwrites the `onchain/aiken/` blueprint path with the chosen on-chain's
artifact, so it tests the real blueprint regardless.
