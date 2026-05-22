# PyCardano Integration — Design

**Status:** Approved (initial pilot)
**Date:** 2026-05-13
**Author:** Th. Kammerlocher (with Claude assistance)
**Tracking:** Adds PyCardano as the fourth off-chain framework in the
`cardano-template-and-ecosystem-monitoring` registry.

## Goal

Add PyCardano (the Python SDK for Cardano) as a first-class off-chain
framework in this repository, so that:

- Python developers can use the examples as templates.
- The dashboard surfaces PyCardano alongside Mesh.js, Evolution SDK, and
  CCL Java.
- CI exercises PyCardano examples against `yaci-devkit` on every push,
  PR, and the nightly schedule.
- Library-version drift is tracked the same way it is for the other
  three frameworks.

## Scope (pilot)

This PR delivers PyCardano implementations for **four** use cases —
chosen to exercise the breadth of PyCardano features without ballooning
the change:

| Use case          | Coverage                                                 |
| ----------------- | -------------------------------------------------------- |
| `simple-transfer` | Parameterised PlutusV3 spend; `apply_param_to_script`; single signer check. |
| `vesting`         | Inline datum; time-locked unlock; slot/time conversion. |
| `htlc`            | Hash-preimage redeemer; multi-branch (`Constr`); validity intervals. |
| `token-transfer`  | Minting policy + parameterised spend; `MultiAsset` value construction. |

(An earlier draft of this spec listed `simple-wallet` as the fifth
pilot. Closer reading shows the existing `simple-wallet` is a
three-validator smart-contract wallet with intent minting — too large
a scope for a runtime smoke-test. It moves to the follow-up batch.)

Remaining 15 use cases (anonymous-data, atomic-transaction, auction,
bet, crowdfund, decentralized-identity, escrow, factory, lottery,
payment-splitter, pricebet, simple-wallet, storage, upgradable-proxy,
vault) are explicitly **out of scope** for this PR and will be added
incrementally in follow-ups, gated on the pilot infrastructure landing
first.

## Non-goals

- Constant-product AMM and Editable NFT (not yet implemented in any
  off-chain framework).
- Migrating other frameworks — PyCardano is purely additive.
- A Python equivalent of CCL Java's blueprint generator/aiken-java-binding.
  We will load `plutus.json` directly using PyCardano's primitives.

## On-disk layout

Each pilot use case gets one directory:

```text
<use-case>/offchain/pycardano/
├── README.md           # How to run locally + setup notes
├── requirements.txt    # Discovery manifest; pins pycardano==X.Y.Z
└── <use-case>.py       # Single-file entrypoint
```

- **Discovery manifest**: `offchain/pycardano/requirements.txt`. This is
  the path the discovery script will glob (`*/offchain/pycardano/requirements.txt`).
- **Entrypoint**: a single `.py` file per example, mirroring the
  one-file-per-example convention in `evolutionsdk`/`meshjs` (`.ts`)
  and `ccl-java` (`.java`).
- **Runtime contract**: each script exposes a `run_scenario()` function
  invoked from `if __name__ == "__main__":`. The script returns
  non-zero on assertion failure or uncaught exception. CI relies only
  on the exit code (`test-status.txt` is written from `${PIPESTATUS[0]}`).

## Script conventions

All pilot scripts share the same connection layer to keep them legible
side-by-side with their TS/Java siblings:

- **Backend**: `BlockFrostChainContext(base_url="http://localhost:8080/api/v1", project_id="Dummy Key")`
  against `yaci-devkit`.
- **Network**: `Network.TESTNET` (yaci-devkit reports testnet magic).
- **Mnemonic**: the standard 24-word test mnemonic shared across the
  other frameworks (`"test test test ... sauce"`).
- **Account derivation**: HD wallet, account index 0 = funder/sender,
  1 = recipient, 2 = oracle (where relevant). Matches the convention in
  `evolutionsdk`/`meshjs` examples.
- **Plutus blueprint**: load `../../onchain/aiken/plutus.json` and feed
  the relevant validator's `compiledCode` into `PlutusV3Script`.
- **Logging**: `print()` for human-readable progress, prefixed with the
  step name (e.g. `LOCK ok. tx=...`), matching the other frameworks.

## CI integration

### 1. `frameworks.json`

Add a fourth entry:

```json
{
  "id": "pycardano",
  "label": "PyCardano",
  "kind": "offchain",
  "discoveryPath": "offchain/pycardano/requirements.txt",
  "statusPrefix": "pycardano"
}
```

Both the dashboard JSON generator and `local-test-discovery.sh` already
iterate `frameworks.json`, so no further changes are needed there.

### 2. `.github/actions/setup-python/action.yml` (new)

Composite action wrapping `actions/setup-python@v5`. Inputs:

- `python-version` (default `3.11`)
- `example` + `subdir` — when both are present, restores a per-example
  pip cache keyed on the `requirements.txt` hash (analogous to the deno
  setup action's per-example cache).

### 3. `.github/workflows/_test-offchain-python.yml` (new)

Modelled on `_test-offchain-deno.yml`. Steps:

1. Checkout
2. `setup-python` (with example + subdir for the pip cache)
3. `setup-yaci-devkit`
4. Download `plutus-<example>` artifact into
   `<example>/onchain/aiken/`
5. `pip install -r requirements.txt`
6. `python <use-case>.py` with `tee test-output.log` and
   `${PIPESTATUS[0]}` → `test-status.txt`; the step itself exits with
   the captured code so the matrix entry reflects the run.
7. Upload `logs-pycardano-<example>` artifact (always)

Inputs match the existing reusable workflows
(`framework-id`, `status-prefix`, `subdir`, `examples`,
`cache-version`).

### 4. `.github/workflows/ecosystem-test.yml`

- Add `pycardano-examples: ${{ steps.discovery.outputs.pycardano-examples }}` to the `discover` job's outputs.
- Add `needs.discover.outputs.pycardano-examples != '[]'` to the
  existing `Setup Yaci DevKit (install only)` step's `if:` (it already
  short-circuits on ccl/mesh/evosdk; we OR in the new prefix).
- New `test-pycardano` job calling `_test-offchain-python.yml` with
  the right inputs.
- Add `test-pycardano` to `report-and-dashboard`'s `needs:`.
- Add a `PYCARDANO_COUNT` line + bullet to the generated `report.md`.

### 5. `versions.json`

Add `"pycardano": "<latest stable from PyPI>"`. The actual version is
resolved at implementation time (`pip index versions pycardano` or
PyPI JSON).

### 6. `scripts/check-library-versions.sh`

- Add `fetch_pypi_latest()` helper (`https://pypi.org/pypi/<pkg>/json`
  → `.info.version`).
- Add `PINNED_PYCARDANO` + `LATEST_PYCARDANO` + a `compare_entry` call.
- Bump `TOTAL_COUNT` from 8 to 9.
- Append the pycardano entry to both the JSON report and the markdown
  table.

### 7. `scripts/sync-versions.sh`

- Read `PYCARDANO_VERSION` from `versions.json`.
- New section "Updating PyCardano requirements.txt files" that walks
  every `offchain/pycardano/requirements.txt` and rewrites
  `pycardano==<old>` to `pycardano==<new>` (with the same drift-check
  branch the other sections already implement).

### 8. `scripts/local-test-offchain.sh`

Add a "Testing PyCardano Examples" block at the end, mirroring the
existing Mesh.js and Evolution SDK blocks: discover with the same find
pattern as the registry, install requirements into a venv per example,
run with `timeout 300 python <file.py>`, write status, count
totals, surface in the summary.

### 9. `CONTRIBUTING.md`

No changes needed — the existing "Adding a new framework" instructions
already describe the registry + CI flow. We rely on the new
`_test-offchain-python.yml` becoming the third reusable workflow class
(Deno-based, JBang-based, Python-based).

## Python version

`3.11` for CI and local development. PyCardano supports 3.8+; 3.11 is
the current stable line on `actions/setup-python@v5` and matches what
most contributors will have locally.

## Validation plan

Per use case, locally:

1. `cd <use-case>/onchain/aiken && aiken build` → produces `plutus.json`.
2. `yaci-devkit up --enable-yaci-store` running on `:8080`.
3. `cd <use-case>/offchain/pycardano && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt`.
4. `python <use-case>.py` exits 0 and the scenario completes.

For the CI scaffold:

1. `bash scripts/local-test-discovery.sh` lists pycardano examples.
2. `bash scripts/generate-dashboard.sh` produces a `docs/dashboard.json`
   with a `pycardano` column for the five pilot use cases.
3. `bash scripts/check-library-versions.sh` reports the pinned vs.
   upstream pycardano version.
4. `bash scripts/sync-versions.sh --check` exits 0 immediately after a
   fresh `sync-versions.sh` run.

## Risks and trade-offs

- **PyCardano API drift**: minor versions of PyCardano have renamed
  helpers in the past. We pin to a single version in `versions.json`
  and let the nightly version-bump PR surface upgrades — same pattern
  the other frameworks already use.
- **Plutus blueprint loading**: PyCardano does not have a built-in
  `PlutusBlueprintLoader` equivalent. We will read `plutus.json`
  manually (it is plain JSON) and pass the `compiledCode` hex to
  `PlutusV3Script`, applying parameters with PyCardano's
  `cbor2`-based helpers. This is straightforward but a small amount of
  boilerplate per script.
- **HD wallet derivation**: PyCardano's `HDWallet` is functional but
  more verbose than Lucid's `selectWallet.fromSeed`. We will accept a
  small helper near the top of each script (or factor a tiny
  `_wallet.py` per dir if the duplication becomes painful — kept out
  of the pilot to avoid premature abstraction).
- **Time alignment with yaci**: The `bet` example revealed the
  zeroTime/slot offset needed to align validators with yaci's eras.
  None of the pilot use cases have hard timing dependencies that
  require this trick (vesting works in absolute POSIX time and tolerates
  yaci drift). If we later add `bet`/`auction`, that alignment
  helper gets factored properly then.

## Out of scope (explicit)

- A `pyproject.toml`-based layout (we chose `requirements.txt` for
  simplicity).
- A shared Python package for cross-example helpers (each script is
  self-contained; the brainstorming gate said no premature abstractions).
- Implementing the remaining 14 use cases — those are follow-up PRs.
- Updating `CONTRIBUTING.md` — the existing flow already covers what
  we are doing.

## Acceptance criteria

- The four pilot scripts run to completion against `yaci-devkit` and
  exit 0.
- `bash scripts/local-test-discovery.sh` lists the four pycardano
  examples under "PyCardano examples".
- `bash scripts/generate-dashboard.sh` produces a `docs/dashboard.json`
  with a `pycardano` status column populated for the four pilot use
  cases and `not-implemented` for the rest.
- `bash scripts/sync-versions.sh --check` reports no drift after a fresh
  sync.
- A push to a topic branch triggers the new `test-pycardano` job in
  GitHub Actions and the resulting `logs-pycardano-*` artifacts feed
  the dashboard.
