# Adding a library to the cross-check

The cross-check matrix runs every Cardano use-case across **on-chain** languages
(Aiken, Scalus, …) × **off-chain** libraries (CCL-Java, Mesh.js, Evolution SDK,
PyCardano, …). This guide shows how to add a new framework with the **minimum**
work. The plumbing is config-driven: a new framework is one `frameworks.json`
entry — the local runner (`scripts/local-test-offchain.sh`) and CI
(`.github/workflows/ecosystem-test.yml`) pick it up automatically.

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
  "runtime": "deno",                            // deno | jbang | python | go (toolchain + run command)
  "versionFile": "offchain/mylib/deno.json",    // optional, for version sync
  "packages": ["my-sdk"]                         // optional, for version sync
}
```

`runtime` is the only thing the runner/CI dispatch on. If your library runs on an
**existing** runtime (`deno`/`jbang`/`python`/`go`), **no script or workflow changes
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

For the `go` runtime, also run `go mod tidy` in each scaffolded directory to
produce a committed `go.sum` — Go builds are `-mod=readonly` by default, so
`go run .` fails without one.

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
   wrapping the flat UPLC), and `hash`. See `auction/onchain/scalus/` for a
   reference (Scalus emits aiken-matching titles via `plutus.json.template`).
3. Add a `compile-<id>` job to `ecosystem-test.yml` (mirroring `compile-scalus`)
   and to `test-offchain`'s + `report-and-dashboard`'s `needs:`. Off-chain combos
   against the new language appear in `offchain-matrix` automatically.
4. In `scripts/local-test-offchain.sh`, add a `build_onchain()` case if the build
   command isn't already `aiken`/`scalus`.

## Safety gate (local runs)

Locally, a non-Aiken combo only runs if the off-chain source references
`PLUTUS_JSON` — otherwise it would re-test the default Aiken blueprint and report a
false positive. Following the contract above (step 3.1) satisfies this gate. CI
instead overwrites the `onchain/aiken/` blueprint path with the chosen on-chain's
artifact, so it tests the real blueprint regardless.
