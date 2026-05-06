# `frameworks/<name>.yml` schema

Each file under `frameworks/` registers one onchain language or offchain SDK with the CI matrix. The CI workflow's discovery step lists `frameworks/*.yml`, groups by `kind`, and emits the matrix axes. **Adding a new framework requires no workflow YAML edits** — only a new descriptor file under this directory.

When the milestone-level Codex review fires (see [docs/design.md](../docs/design.md) once that lands; in the interim, see the plan), descriptors are part of the diff Codex evaluates.

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
  #   ${{ env.AIKEN_VERSION }}, ${{ env.DENO_VERSION }}, ${{ env.NODE_VERSION }},
  #   ${{ env.JDK_VERSION }}, ${{ env.JBANG_VERSION }}, ${{ env.MESHJS_VERSION }},
  #   ${{ env.LUCID_EVOLUTION_VERSION }}, ${{ env.CARDANO_CLIENT_LIB_VERSION }},
  #   ${{ env.YACI_DEVKIT_VERSION }}.
  # The exact set of env names mirrors versions.yml keys uppercased and suffixed
  # with `_VERSION` (e.g. `meshjs:` → `MESHJS_VERSION`).
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
  #   a synthetic result.json from {framework, use_case, exit_code}. Use only
  #   when the example pre-dates the runner contract (see
  #   docs/reference/result-json.md).

# REQUIRED for offchain frameworks — whether this framework needs Yaci DevKit
needs_yaci: true             # true | false. When true, the offchain test job
                              # for any use case that uses this framework starts
                              # one shared Yaci instance before any framework runs.
```

## Notes

- The CI workflow consumes descriptors via `.github/actions/run-framework/` (lands in P1W1). That composite action takes the framework name and the use case path as inputs and resolves the descriptor's `setup` and `run` blocks at runtime.
- A descriptor whose `kind: onchain` participates in the `compile-onchain` matrix job; its `run.command` is expected to compile the contract and emit any artifacts the offchain side needs (e.g. `plutus.json`).
- A descriptor whose `kind: offchain` participates in the `test-offchain` matrix job (one job per use case, all configured offchain frameworks running sequentially against the shared Yaci).
- Adding a fifth offchain SDK is one PR adding one file under `frameworks/`. Zero workflow YAML edits, zero discovery-script edits.
- See `docs/how-to/add-framework.md` (lands in P1W2) for the contributor walkthrough.
