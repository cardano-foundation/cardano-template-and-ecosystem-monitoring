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

- **Runtime entry**: the CI workflow consumes descriptors via [`scripts/ci/run-cell.sh`](../scripts/ci/run-cell.sh). The script reads the descriptor's `kind`, `manifest_key`, `run.cwd_relative_to_example`, `run.command`, `default_entry`, and `result.convention`, resolves the entry file from the use-case manifest, and runs the cell. A `composite action` previously wrapped the script but added no value beyond a thin parameter shape, so it was removed in P1W1's iteration 2 cleanup; the script is the public interface.
- **Discovery**: [`scripts/local-test-discovery.sh`](../scripts/local-test-discovery.sh) enumerates `frameworks/*.yml` to know which frameworks are registered, then walks every use case and decides which of those frameworks each use case ships (manifest mode preferred, heuristic fallback for unmanifested use cases). Discovery is generic over registered frameworks — adding a new descriptor is sufficient.
- **Onchain frameworks** (`kind: onchain`) participate in the `compile-onchain` matrix job; the `run.command` is expected to compile the contract and emit any artifacts the offchain side needs (e.g. `plutus.json`).
- **Offchain frameworks** (`kind: offchain`) participate in the `test-offchain` matrix job (one job per use case; every registered offchain framework declared by the use case runs sequentially against the shared Yaci DevKit instance).
- **Pilot limitations (P1W1)** — labeled honestly so contributors know what is and isn't generic:
  - The workflow installs every offchain runtime (Deno, JDK + JBang, Yaci) unconditionally for each offchain job. The descriptor's `setup:` block and `needs_yaci:` flag are not yet consumed — they are documentation for how a contributor would write a new descriptor. A future descriptor with `needs_yaci: false` will silently get Yaci installed; that is a known limitation, not a hidden bug.
  - **Onchain CI generalization is also pilot-stage**: discovery handles any `kind: onchain` descriptor generically, but the CI workflow has a single `compile-aiken` job hard-coded to install Aiken and emit `plutus.json`. Adding a new onchain language (Scalus, plu-ts, OpShin, …) as a CI matrix child therefore requires one PR adding `frameworks/<name>.yml` PLUS one PR adding a sibling `compile-<name>` job in `.github/workflows/ecosystem-test.yml`. The descriptor → CI generalization for onchain is P1W2 work. The `compile-aiken` job's `if:` gate makes this honest: if `aiken` is no longer registered, the job is skipped.
  - P1W2 takes over selective runtime setup, full descriptor consumption (including `setup:` and `needs_yaci:`), and the onchain CI generalization once the contract is settled.
- **Adding a new offchain framework**: one PR adding one file under `frameworks/` (and per-use-case, one `manifest_key:` entry under `<use-case>/example.yml`). Zero workflow YAML edits, zero discovery-script edits required.
- **Adding a new onchain language**: see the pilot limitation above — needs both the descriptor AND a sibling `compile-<framework>` job.
- See `docs/how-to/add-framework.md` (lands in P1W2) for the contributor walkthrough.
