# How to add a new framework

Goal: register a new offchain SDK or onchain language so that every use case that ships an implementation in it appears as a new column in the CI matrix.

## Prerequisites

- The framework must be installable in CI (Linux runner) via shell or a published GitHub Action.
- You know which version you want to pin.
- For onchain languages: you have a clear answer to "what artifact does the compile step produce, and where does the offchain side find it?" (Aiken's answer is `plutus.json`.)

## Steps

### 1. Run the scaffolder

```sh
scripts/scaffold-framework.sh KIND=<offchain|onchain> NAME=<name>
```

For example:

```sh
scripts/scaffold-framework.sh KIND=offchain NAME=opshin
scripts/scaffold-framework.sh KIND=onchain NAME=plu-ts
```

The scaffolder creates `frameworks/<name>.yml` from a templated stub. It refuses to overwrite an existing descriptor.

### 2. Fill in the descriptor's `setup:` and `run:` blocks

Open `frameworks/<name>.yml`. The TODO blocks tell you exactly what to replace. Reference the existing descriptors as templates:

- [`frameworks/aiken.yml`](../../frameworks/aiken.yml) — onchain language with curl-based install
- [`frameworks/meshjs.yml`](../../frameworks/meshjs.yml) — offchain SDK using `actions/setup-deno`
- [`frameworks/lucid-evolution.yml`](../../frameworks/lucid-evolution.yml) — offchain SDK on Deno
- [`frameworks/ccl-java.yml`](../../frameworks/ccl-java.yml) — offchain SDK using `actions/setup-java` plus a curl-based JBang install

The `run.command` is a shell command run from `<use-case>/<run.cwd_relative_to_example>/`. `$ENTRY` is substituted with the entry file resolved from the manifest.

### 3. Add a pinned version to `versions.yml`

```yaml
<key>: "<version>"
```

For example: `opshin: "0.21.0"`. Use lowercase, snake_case keys. The CI workflow exports this as `<KEY>_VERSION` (uppercase) automatically; reference it from your descriptor's `setup:` block as `${{ env.OPSHIN_VERSION }}`.

### 4. (Onchain only) Add a sibling `compile-<name>` job to the workflow

Onchain languages currently need a per-language compile job in [`.github/workflows/ecosystem-test.yml`](../../.github/workflows/ecosystem-test.yml) because their setup commands and output artifacts vary too much to be made fully generic. Use `compile-aiken` as the template:

- Copy the job, rename to `compile-<name>`.
- Replace the install commands with the language's.
- Replace the build command with the language's.
- Update the artifact upload to point at the right artifact path.
- Add the framework name to the `if:` gate so the job only runs when registered.

This is a known limitation — see [`frameworks/SCHEMA.md`](../../frameworks/SCHEMA.md) "Limitations" for the rationale and the path to closing it.

For offchain frameworks: skip this step. The `test-offchain` job already iterates every offchain framework declared in each use case's manifest, so a new offchain SDK is automatically picked up.

### 5. Reference the framework in any use case's manifest

For each `<use-case>/example.yml` that ships an implementation in the new framework, add an entry under the appropriate section:

```yaml
onchain:                      # or offchain:
  <manifest_key>:
    path: <onchain|offchain>/<framework>
    entry: <file>
```

Use `scripts/scaffold-use-case-implementation.sh` (see [`add-use-case-implementation.md`](add-use-case-implementation.md)) to create the directory and stub entry file.

### 6. Verify discovery picks it up

```sh
scripts/local-test-discovery.sh
```

You should see the new framework listed under "Registered framework descriptors", and any use case that declares it under "Manifest-mode discovery".

### 7. Push the branch

CI runs the new framework's cells automatically.

## What just happened

You added one descriptor file under `frameworks/`, one version pin in `versions.yml`, and (for onchain) one sibling job in the workflow. Discovery enumerates `frameworks/*.yml` at runtime, so the new framework is picked up without edits to the discovery script. The runner reads the descriptor at runtime, so a new SDK with a different install command is supported without edits to the runner. Adding the same framework to a sixth use case is one manifest edit per use case — never a workflow edit.

If your descriptor is wrong, the failure mode is interpretable: the cell appears in the matrix as a `fail` with `error_summary` describing what broke (missing entry file, wrong cwd, command failure). Iterate on the descriptor until the cell goes green.

## Manual flow (without the scaffolder)

If `scripts/scaffold-framework.sh` is unavailable or you want to write the descriptor by hand: copy the closest existing descriptor in `frameworks/` to `frameworks/<name>.yml`, change the `name`, `manifest_key`, and `run.cwd_relative_to_example` fields, replace the `setup:` and `run:` blocks. The rest of the steps above apply unchanged.
