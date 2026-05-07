# `frameworks/<name>.yml` schema

Each file under `frameworks/` registers one onchain language or offchain SDK with the CI matrix. The CI workflow's discovery step lists `frameworks/*.yml`, groups by `kind`, and emits the matrix axes.

- **Adding a new offchain SDK**: one new descriptor file is sufficient. Zero workflow YAML edits, zero discovery-script edits required.
- **Adding a new onchain language**: descriptor + a sibling `compile-<framework>` job in the workflow. The workflow side is genuinely generic for matrix membership but framework-specific for setup and artifact handling. See "Limitations" below.

## Fields

```yaml
# REQUIRED
name: meshjs                  # framework identifier; must match the filename stem
kind: offchain                # offchain | onchain
manifest_key: meshjs          # the key used inside <use-case>/example.yml under
                              #   onchain: or offchain: — typically equal to `name`

# OPTIONAL — overrides per use case in <use-case>/example.yml
default_entry: "*.ts"         # glob the runner uses to find the entry file when the
                              #   use case's manifest does not name an explicit entry

# REQUIRED — how CI installs this framework
setup:
  # A list of GitHub Actions composite-action steps. Each step has the same shape
  # as a step in a normal action (uses, run, with, env). Steps may reference
  # version env vars exported by `.github/actions/load-versions/`:
  #   AIKEN_VERSION, DENO_VERSION, NODE_VERSION, JDK_VERSION, JBANG_VERSION,
  #   MESHJS_VERSION, LUCID_EVOLUTION_VERSION, CARDANO_CLIENT_LIB_VERSION,
  #   YACI_DEVKIT_VERSION (every key in versions.yml uppercased + _VERSION).
  - uses: denoland/setup-deno@v2
    with:
      deno-version: ${{ env.DENO_VERSION }}

# REQUIRED — how CI runs this framework against an example
run:
  cwd_relative_to_example: "offchain/meshjs"   # working directory relative to the
                                                # use-case directory
  command: "deno run --allow-all $ENTRY"        # shell command. $ENTRY is substituted
                                                # with the resolved entry file (from
                                                # the manifest entry: field, or
                                                # default_entry).

# REQUIRED — how the runner detects pass/fail
result:
  convention: result-json    # result-json | exit-code
  # result-json (preferred): the run is expected to write a `result.json` to its
  #   working directory and exit non-zero on failure. The aggregator reads the
  #   JSON to populate the matrix.
  # exit-code (legacy): exit code is the only signal. The aggregator generates
  #   a synthetic result.json from {framework, use_case, exit_code}.

# REQUIRED for offchain frameworks — whether this framework needs Yaci DevKit
needs_yaci: true             # true | false. When true, the offchain test job
                              # for any use case that uses this framework starts
                              # one shared Yaci instance before any framework runs.
```

## Notes

- **Runtime entry**: the CI workflow consumes descriptors via [`scripts/ci/run-cell.sh`](../scripts/ci/run-cell.sh). The script reads the descriptor's `kind`, `manifest_key`, `run.cwd_relative_to_example`, `run.command`, `default_entry`, and `result.convention`, resolves the entry file from the use-case manifest, and runs the cell. The script is the public runtime interface — there is no composite action wrapper.
- **Discovery**: [`scripts/local-test-discovery.sh`](../scripts/local-test-discovery.sh) enumerates `frameworks/*.yml` to know which frameworks are registered, then walks every `<use-case>/example.yml` manifest to decide which of those frameworks each use case ships. A use case directory without a manifest is a discovery error; a manifest entry whose `manifest_key` has no matching descriptor (typos, `kind:` mismatches) is also a discovery error — silent skips would drop a cell from the matrix. Discovery is generic over registered frameworks: adding a new descriptor is sufficient to make discovery aware of it.
- **Onchain frameworks** (`kind: onchain`) participate in a per-language compile job — today only `compile-aiken`. The `run.command` is expected to compile the contract and emit any artifacts the offchain side needs (e.g. `plutus.json`). See "Limitations" for why the onchain side has one job per language rather than one generic `compile-onchain`.
- **Offchain frameworks** (`kind: offchain`) participate in the `test-offchain` matrix job (one job per use case; every registered offchain framework declared by the use case runs sequentially against the shared Yaci DevKit instance).
- **Limitations** — labeled honestly so contributors know what is and isn't generic:
  - The workflow installs every offchain runtime (Deno, JDK + JBang, Yaci) unconditionally for each offchain job. The descriptor's `setup:` block and `needs_yaci:` flag are not yet consumed by the workflow — they are documentation for how a contributor would write a new descriptor. A future descriptor with `needs_yaci: false` will silently get Yaci installed; that is a known limitation, not a hidden bug.
  - **Onchain CI generalization is also pilot-stage**: discovery handles any `kind: onchain` descriptor generically, but the CI workflow has a single `compile-aiken` job hard-coded to install Aiken and emit `plutus.json`. Adding a new onchain language (Scalus, plu-ts, OpShin, …) as a CI matrix child therefore requires one PR adding `frameworks/<name>.yml` PLUS one PR adding a sibling `compile-<name>` job in `.github/workflows/ecosystem-test.yml`. The `compile-aiken` job's `if:` gate makes this honest: if `aiken` is no longer registered, the job is skipped.
- **Adding a new offchain framework**: one PR adding one file under `frameworks/` (and per-use-case, one `manifest_key:` entry under `<use-case>/example.yml`). Zero workflow YAML edits, zero discovery-script edits required.
- **Adding a new onchain language**: see the limitation above — needs both the descriptor AND a sibling `compile-<framework>` job.

## Primitive scenario JSON (`conformance/primitives/<id>/scenarios/<era>/*.json`)

Each scenario asserts one (input, expected output) pair for a Tier 1 conformance primitive. Scenarios are tagged by Cardano protocol era; new eras are sibling folders, never diffs.

### Required fields

```json
{
  "id":          "encoding/datum-cbor-roundtrip/conway/simple-int",
  "primitive":   "encoding/datum-cbor-roundtrip",
  "era":         "conway",
  "description": "human-readable text — also used as the scenario's documentation in the dashboard",
  "input":       { /* primitive-specific input */ },
  "expected":    { /* primitive-specific expected output */ }
}
```

- `id` — globally unique scenario identifier. Convention: `<primitive>/<era>/<short-name>`. Used as the cell id in `matrix.json`.
- `primitive` — the primitive id (matches the directory path under `conformance/primitives/`). Adapters dispatch on this value.
- `era` — Cardano protocol era. Must match the parent folder name; matches `versions.yml`'s `protocol_version` for the run that produced this scenario.
- `description` — plain-English explanation of what's tested and why. Read by humans; rendered on the dashboard's per-scenario tooltip.
- `input` — primitive-specific input shape. Documented per-primitive in the primitive's `README.md`.
- `expected` — primitive-specific expected output shape. The adapter's impl returns a value; equality against `expected` determines pass/fail.

### Layout

```
conformance/primitives/<category>/<name>/
├── README.md                       teaching unit for this primitive
└── scenarios/<era>/<short-name>.json
```

Categories today: `encoding/`, `tx-building/` (P2W2), `plutus-eval/` (P2W2). `governance/` is reserved.

### Adapters

Every registered offchain SDK provides an adapter under `conformance/adapters/<framework>/`. The adapter:

1. Reads the scenario JSON.
2. Dispatches on `scenario.primitive` to a per-primitive impl.
3. Calls the SDK's API to produce an observed value.
4. Compares observed to expected via deep equality.
5. Writes a `result.json` with `{tier: "primitive", id, primitive, framework, era, status, duration_ms, observed, expected, error_summary?}`.
6. Exits 0 on pass or skipped, 1 on fail.

If an adapter has no impl for a primitive, the scenario is reported as `skipped` (not `fail`); coverage growth across SDKs is measurable.
