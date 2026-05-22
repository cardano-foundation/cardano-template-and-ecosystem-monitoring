# PyCardano Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PyCardano as the fourth off-chain framework in this repository, with full CI/dashboard wiring and four pilot use cases (simple-transfer, vesting, htlc, token-transfer).

**Architecture:** New per-example layout `<use-case>/offchain/pycardano/{<name>.py, requirements.txt, README.md}` discovered via a new entry in `frameworks.json`. A new composite `setup-python` action and a new reusable `_test-offchain-python.yml` workflow run each example against `yaci-devkit`'s Blockfrost-compatible endpoint, capturing exit code into `test-status.txt` and uploading `logs-pycardano-<example>` artifacts that the existing dashboard generator consumes generically.

**Tech Stack:** Python 3.11, PyCardano 0.19.2 (pinned in `versions.json`), `BlockFrostChainContext` against yaci-devkit on `localhost:8080`, PlutusV3 scripts loaded from `plutus.json` blueprints already produced by Aiken.

---

## File Structure

**New files:**
- `.github/actions/setup-python/action.yml` — composite action: install Python, restore per-example pip cache.
- `.github/workflows/_test-offchain-python.yml` — reusable workflow modelled on `_test-offchain-deno.yml`.
- `simple-transfer/offchain/pycardano/{simple_transfer.py, requirements.txt, README.md}`
- `vesting/offchain/pycardano/{vesting.py, requirements.txt, README.md}`
- `htlc/offchain/pycardano/{htlc.py, requirements.txt, README.md}`
- `token-transfer/offchain/pycardano/{token_transfer.py, requirements.txt, README.md}`

**Modified files:**
- `frameworks.json` — add `pycardano` entry.
- `versions.json` — add `"pycardano"` pin.
- `.github/workflows/ecosystem-test.yml` — add `discover` output, extend yaci-devkit `if:`, new `test-pycardano` job, extend `report-and-dashboard` `needs:` and report block.
- `scripts/check-library-versions.sh` — add PyPI helper + pycardano comparison + bump `TOTAL_COUNT`.
- `scripts/sync-versions.sh` — add pycardano section.
- `scripts/local-test-offchain.sh` — add "Testing PyCardano Examples" block.

Each pilot script is one self-contained `.py` file; we do not introduce a shared helper module in this PR (YAGNI — revisit when ≥6 examples exist).

---

## Conventions for every pilot script

To keep the four scripts legible side-by-side, all of them follow the same skeleton:

```python
"""<one-line summary>"""
import json
import time
from pathlib import Path

from blockfrost import ApiUrls
from pycardano import (
    Address, BlockFrostChainContext, ExtendedSigningKey, HDWallet,
    Network, PaymentVerificationKey, PlutusV3Script, ScriptHash,
    TransactionBuilder, TransactionOutput, VerificationKeyHash,
    Value, plutus_script_hash, ...
)

YACI_URL = "http://localhost:8080/api/v1"
NETWORK = Network.TESTNET
TEST_MNEMONIC = (
    "test test test test test test test test test test test test "
    "test test test test test test test test test test test sauce"
)
BLUEPRINT_PATH = Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json"


def context() -> BlockFrostChainContext:
    return BlockFrostChainContext(project_id="Dummy Key", base_url=YACI_URL)


def wallet_at(account_index: int) -> tuple[ExtendedSigningKey, Address]:
    hd = HDWallet.from_mnemonic(TEST_MNEMONIC)
    payment = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/0/0")
    stake = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/2/0")
    psk = ExtendedSigningKey.from_hdwallet(payment)
    ssk = ExtendedSigningKey.from_hdwallet(stake)
    addr = Address(
        payment_part=psk.to_verification_key().hash(),
        staking_part=ssk.to_verification_key().hash(),
        network=NETWORK,
    )
    return psk, addr


def load_validator(title_prefix: str) -> tuple[bytes, list[dict]]:
    """Return (compiledCode_bytes, parameters_schema_list) for the validator whose title starts with the prefix."""
    blueprint = json.loads(BLUEPRINT_PATH.read_text())
    v = next(x for x in blueprint["validators"] if x["title"].startswith(title_prefix))
    return bytes.fromhex(v["compiledCode"]), v.get("parameters", [])


def wait_for_utxos(ctx: BlockFrostChainContext, address: Address, min_count: int = 1, timeout_s: int = 60) -> None:
    for _ in range(timeout_s):
        try:
            if len(ctx.utxos(str(address))) >= min_count:
                return
        except Exception:
            pass
        time.sleep(1)
    raise TimeoutError(f"≥{min_count} UTxO never appeared at {address}")


def run_scenario() -> None:
    ...


if __name__ == "__main__":
    run_scenario()
```

Each task that creates a script provides the full file body, not just the deltas; do not abbreviate.

---

## Task 1: Pin pycardano in versions.json

**Files:**
- Modify: `versions.json`

- [ ] **Step 1: Add the pycardano entry**

Edit `versions.json` to read:

```json
{
  "aiken-compiler": "v1.1.21",
  "aiken-lang/stdlib": "v3.1.0",
  "sidan-lab/vodka": "0.1.23",
  "@meshsdk/core": "1.9.0-beta.102",
  "@meshsdk/core-csl": "1.9.0-beta.102",
  "@meshsdk/common": "1.9.0-beta.102",
  "@evolution-sdk/lucid": "2.0.1",
  "cardano-client-lib": "0.8.0-pre4",
  "pycardano": "0.19.2"
}
```

- [ ] **Step 2: Verify the file parses**

Run: `jq '.pycardano' versions.json`
Expected: `"0.19.2"`

- [ ] **Step 3: Commit**

```bash
git add versions.json
git commit -m "chore: pin pycardano 0.19.2 in versions.json"
```

---

## Task 2: Register pycardano in the framework registry

**Files:**
- Modify: `frameworks.json`

- [ ] **Step 1: Add the fourth registry entry**

Edit `frameworks.json` to read:

```json
{
  "frameworks": [
    {
      "id": "aiken",
      "label": "Aiken",
      "kind": "onchain",
      "discoveryPath": "onchain/aiken/aiken.toml",
      "statusPrefix": "aiken"
    },
    {
      "id": "ccl-java",
      "label": "CCL Java",
      "kind": "offchain",
      "discoveryPath": "offchain/ccl-java/*.java",
      "statusPrefix": "ccl"
    },
    {
      "id": "meshjs",
      "label": "Mesh.js",
      "kind": "offchain",
      "discoveryPath": "offchain/meshjs/deno.json",
      "statusPrefix": "mesh"
    },
    {
      "id": "evolutionsdk",
      "label": "Evolution SDK",
      "kind": "offchain",
      "discoveryPath": "offchain/evolutionsdk/deno.json",
      "statusPrefix": "evosdk"
    },
    {
      "id": "pycardano",
      "label": "PyCardano",
      "kind": "offchain",
      "discoveryPath": "offchain/pycardano/requirements.txt",
      "statusPrefix": "pycardano"
    }
  ]
}
```

- [ ] **Step 2: Verify discovery picks up the new entry shape**

Run: `bash scripts/local-test-discovery.sh`
Expected: the summary line `PyCardano examples:        0` appears (zero is fine — no examples exist yet). No errors.

- [ ] **Step 3: Commit**

```bash
git add frameworks.json
git commit -m "feat: add pycardano entry to frameworks registry"
```

---

## Task 3: Create the setup-python composite action

**Files:**
- Create: `.github/actions/setup-python/action.yml`

- [ ] **Step 1: Write the action file**

Create `.github/actions/setup-python/action.yml` with this content:

```yaml
name: 'Setup Python'
description: 'Install Python; optionally cache per-example pip dependencies.'

inputs:
  python-version:
    description: 'Python version (e.g. 3.11).'
    required: false
    default: '3.11'
  example:
    description: 'Example name. When provided together with subdir, the action also
      restores a per-example pip cache keyed on the requirements.txt hash.'
    required: false
    default: ''
  subdir:
    description: 'Sub-path under the example, e.g. offchain/pycardano.'
    required: false
    default: ''

runs:
  using: composite
  steps:
    - name: Install Python
      uses: actions/setup-python@v5
      with:
        python-version: ${{ inputs.python-version }}

    - name: Restore per-example pip cache
      if: inputs.example != '' && inputs.subdir != ''
      uses: actions/cache@v4
      with:
        path: ~/.cache/pip
        key: pip-${{ inputs.example }}-${{ hashFiles(format('{0}/{1}/requirements.txt', inputs.example, inputs.subdir)) }}
```

- [ ] **Step 2: Verify YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/actions/setup-python/action.yml'))" && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add .github/actions/setup-python/action.yml
git commit -m "ci: add setup-python composite action"
```

---

## Task 4: Create the Python reusable test workflow

**Files:**
- Create: `.github/workflows/_test-offchain-python.yml`

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/_test-offchain-python.yml` with this content:

```yaml
name: Test off-chain (Python-based, reusable)

# Reusable workflow used by every Python-based off-chain framework
# (PyCardano today). The caller supplies the framework id, the on-disk
# subdir, the matrix of examples, and the status prefix used for log
# artifacts (consumed by report-and-dashboard).

on:
  workflow_call:
    inputs:
      framework-id:
        description: 'Identifier matching frameworks.json (e.g. pycardano).'
        type: string
        required: true
      status-prefix:
        description: 'Short prefix used in the log/status artifact names (e.g. pycardano).'
        type: string
        required: true
      subdir:
        description: 'Path under the example dir containing the requirements.txt entrypoint.'
        type: string
        required: true
      examples:
        description: 'JSON array of example names to run.'
        type: string
        required: true
      python-version:
        description: 'Python version.'
        type: string
        required: false
        default: '3.11'
      cache-version:
        description: 'Cache-buster forwarded to setup-* actions.'
        type: string
        required: false
        default: 'v1'

jobs:
  test:
    name: Test ${{ inputs.framework-id }} - ${{ matrix.example }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        example: ${{ fromJson(inputs.examples) }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Python
        uses: ./.github/actions/setup-python
        with:
          python-version: ${{ inputs.python-version }}
          example: ${{ matrix.example }}
          subdir: ${{ inputs.subdir }}

      - name: Setup Yaci DevKit
        uses: ./.github/actions/setup-yaci-devkit
        with:
          cache-version: ${{ inputs.cache-version }}

      - name: Download plutus.json artifact
        uses: actions/download-artifact@v4
        with:
          name: plutus-${{ matrix.example }}
          path: ${{ matrix.example }}/onchain/aiken/

      - name: Install Python dependencies
        working-directory: ${{ matrix.example }}/${{ inputs.subdir }}
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements.txt

      - name: Run off-chain test
        working-directory: ${{ matrix.example }}/${{ inputs.subdir }}
        env:
          EXAMPLE: ${{ matrix.example }}
          SUBDIR: ${{ inputs.subdir }}
        run: |
          PY_FILE=$(ls *.py | head -1)
          echo "Running python on $EXAMPLE/$SUBDIR/$PY_FILE"
          set +e
          timeout 300 python "$PY_FILE" 2>&1 | tee test-output.log
          EXIT=${PIPESTATUS[0]}
          set -e
          if [ "$EXIT" -eq 0 ]; then echo success > test-status.txt; else echo failed > test-status.txt; fi
          exit "$EXIT"

      - name: Upload test logs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: logs-${{ inputs.status-prefix }}-${{ matrix.example }}
          path: |
            ${{ matrix.example }}/${{ inputs.subdir }}/test-output.log
            ${{ matrix.example }}/${{ inputs.subdir }}/test-status.txt
          retention-days: 30
```

- [ ] **Step 2: Verify YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/_test-offchain-python.yml'))" && echo OK`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/_test-offchain-python.yml
git commit -m "ci: add reusable python-based offchain test workflow"
```

---

## Task 5: Wire the test-pycardano job into ecosystem-test.yml

**Files:**
- Modify: `.github/workflows/ecosystem-test.yml` (multiple sections)

- [ ] **Step 1: Add the pycardano output to the discover job**

Locate the `outputs:` block of the `discover` job (around lines 38-42 in the current file) and update it so all four offchain outputs are present:

```yaml
    outputs:
      aiken-examples: ${{ steps.discovery.outputs.aiken-examples }}
      ccl-examples: ${{ steps.discovery.outputs.ccl-examples }}
      mesh-examples: ${{ steps.discovery.outputs.mesh-examples }}
      evosdk-examples: ${{ steps.discovery.outputs.evosdk-examples }}
      pycardano-examples: ${{ steps.discovery.outputs.pycardano-examples }}
```

- [ ] **Step 2: Extend the Yaci DevKit install condition**

Locate the `Setup Yaci DevKit (install only)` step inside `prepare-toolchains`. Its `if:` currently OR-s the three offchain prefixes; add the pycardano clause:

```yaml
      - name: Setup Yaci DevKit (install only)
        if: |
          needs.discover.outputs.ccl-examples != '[]' ||
          needs.discover.outputs.mesh-examples != '[]' ||
          needs.discover.outputs.evosdk-examples != '[]' ||
          needs.discover.outputs.pycardano-examples != '[]'
        uses: ./.github/actions/setup-yaci-devkit
        with:
          start: 'false'
          cache-version: ${{ env.CACHE_VERSION }}
```

- [ ] **Step 3: Add the `test-pycardano` job**

Immediately after the `test-evolutionsdk:` block (and before the `ADDING A NEW FRAMEWORK` comment), insert:

```yaml
  test-pycardano:
    needs: [discover, prepare-toolchains, compile-aiken]
    if: needs.discover.outputs.pycardano-examples != '[]'
    uses: ./.github/workflows/_test-offchain-python.yml
    with:
      framework-id: pycardano
      status-prefix: pycardano
      subdir: offchain/pycardano
      examples: ${{ needs.discover.outputs.pycardano-examples }}
      cache-version: v1
```

- [ ] **Step 4: Add `test-pycardano` to report-and-dashboard's needs**

Update the `needs:` list of `report-and-dashboard`:

```yaml
    needs: [compile-aiken, test-ccl-java, test-mesh, test-evolutionsdk, test-pycardano]
```

- [ ] **Step 5: Add the PyCardano count to the report**

Inside the `Generate markdown report` step, after the `EVOSDK_COUNT=...` line, add:

```bash
          PYCARDANO_COUNT=$(find artifacts -name "logs-pycardano-*" -type d 2>/dev/null | wc -l)
```

And after the existing `echo "- **Evolution SDK Tests**: $EVOSDK_COUNT" >> report.md` line, add:

```bash
          echo "- **PyCardano Tests**: $PYCARDANO_COUNT" >> report.md
```

- [ ] **Step 6: Verify the YAML still parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ecosystem-test.yml'))" && echo OK`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ecosystem-test.yml
git commit -m "ci: wire pycardano into ecosystem-test workflow"
```

---

## Task 6: Add pycardano to check-library-versions.sh

**Files:**
- Modify: `scripts/check-library-versions.sh`

- [ ] **Step 1: Add the PyPI fetch helper**

After the `fetch_npm_latest` helper definition (around line 84 in the current file), insert this new helper block:

```bash
# ── PyPI registry helper ────────────────────────────────────────────────────────
# Usage: fetch_pypi_latest <package>
# Prints the latest version string, or "unknown" on failure.
fetch_pypi_latest() {
  local pkg="$1"
  local response
  response=$(curl -s --max-time 10 \
    "https://pypi.org/pypi/${pkg}/json" 2>/dev/null) || true

  local ver
  ver=$(printf '%s' "$response" | jq -r '.info.version // empty' 2>/dev/null) || true

  if [ -z "$ver" ] || [ "$ver" = "null" ]; then
    echo "unknown"
  else
    echo "$ver"
  fi
}
```

- [ ] **Step 2: Read the pinned pycardano version**

After the `PINNED_CCL=...` line near the top of the script, add:

```bash
PINNED_PYCARDANO=$(jq -r '.["pycardano"]'                "$VERSIONS_FILE")
```

- [ ] **Step 3: Fetch the latest pycardano version**

In the `Fetch all upstream versions` section, after `LATEST_CCL=...`, add:

```bash
LATEST_PYCARDANO=$(fetch_pypi_latest "pycardano")
```

- [ ] **Step 4: Bump TOTAL_COUNT and add the comparison**

Change `TOTAL_COUNT=8` to `TOTAL_COUNT=9`.

After the `compare_entry "cardano-client-lib"  "$PINNED_CCL"             "$LATEST_CCL"` / `ENTRY_CCL="$ENTRY_JSON"` pair, append:

```bash
compare_entry "pycardano"            "$PINNED_PYCARDANO"       "$LATEST_PYCARDANO"
ENTRY_PYCARDANO="$ENTRY_JSON"
```

- [ ] **Step 5: Emit pycardano into the JSON report**

In the `cat > "$JSON_FILE"` heredoc, change the `libraries` block to include the new entry as the final element:

```bash
  "libraries": {
    ${ENTRY_AIKEN_COMPILER},
    ${ENTRY_STDLIB},
    ${ENTRY_VODKA},
    ${ENTRY_MESH_CORE},
    ${ENTRY_MESH_CORE_CSL},
    ${ENTRY_MESH_COMMON},
    ${ENTRY_LUCID},
    ${ENTRY_CCL},
    ${ENTRY_PYCARDANO}
  },
```

- [ ] **Step 6: Emit pycardano into the markdown report**

In the `MD_FILE` heredoc's body, after the last `print_md_row "cardano-client-lib" ...` call, add:

```bash
  print_md_row "pycardano"            "$PINNED_PYCARDANO"       "$LATEST_PYCARDANO"
```

- [ ] **Step 7: Run it locally and verify**

Run: `bash scripts/check-library-versions.sh`
Expected: among the output lines, `pycardano: 0.19.2 (up to date)` (or with `→ <newer>` if PyPI has rolled forward).
Expected: `jq '.libraries.pycardano' .local-test-results/version-report.json` prints a populated object.

- [ ] **Step 8: Commit**

```bash
git add scripts/check-library-versions.sh
git commit -m "ci: track pycardano version drift in version checker"
```

---

## Task 7: Add pycardano to sync-versions.sh

**Files:**
- Modify: `scripts/sync-versions.sh`

- [ ] **Step 1: Read the pinned version**

After the `CCL_VERSION=$(jq -r '.["cardano-client-lib"]' "$VERSIONS_FILE")` line, add:

```bash
PYCARDANO_VERSION=$(jq -r '.["pycardano"]' "$VERSIONS_FILE")
```

- [ ] **Step 2: Echo it in the banner**

After the `echo "  cardano-client-lib:    $CCL_VERSION"` line, add:

```bash
echo "  pycardano:             $PYCARDANO_VERSION"
```

- [ ] **Step 3: Add the PyCardano requirements.txt sync section**

After the `=== Updating CCL Java files ===` block (the `while IFS=... done` loop that processes `*.java` files) and before the final `if [ "$CHECK_MODE" = true ]; then` summary block, insert:

```bash
# ── 5. PyCardano requirements.txt files ────────────────────────────────────────
echo "=== Updating PyCardano requirements.txt files ==="

update_pypi_dep() {
  local file="$1"
  local pkg="$2"
  local target_ver="$3"

  if ! grep -qE "^${pkg}==" "$file" 2>/dev/null; then
    return 0
  fi

  local current_ver
  current_ver=$(grep -E "^${pkg}==" "$file" | head -1 | sed -E "s|^${pkg}==||" | tr -d '[:space:]')

  if [ "$current_ver" = "$target_ver" ]; then
    echo -e "  ${YELLOW}[SKIP]${NC}    ${pkg} already up to date in $(basename "$file") ($file)"
  elif [ "$CHECK_MODE" = true ]; then
    echo -e "  ${RED}[DRIFT]${NC}   ${pkg}: has '$current_ver', want '$target_ver' in $file"
    DRIFTED_FILES+=("$file")
  else
    sed_inplace "$file" \
      "s|^(${pkg}==).*$|\1${target_ver}|"
    echo -e "  ${GREEN}[UPDATED]${NC} ${pkg} in $(basename "$file") ($file)"
  fi
}

while IFS= read -r -d '' req_file; do
  update_pypi_dep "$req_file" "pycardano" "$PYCARDANO_VERSION"
done < <(find "$REPO_ROOT" -path "*/offchain/pycardano/requirements.txt" -print0 | sort -z)

echo ""
```

- [ ] **Step 4: Verify (will be a no-op until requirements files exist)**

Run: `bash scripts/sync-versions.sh`
Expected: no errors; the new section prints `=== Updating PyCardano requirements.txt files ===` and then nothing (no requirements files yet).

Run: `bash scripts/sync-versions.sh --check`
Expected: exits 0; reports `All files are consistent with versions.json.`

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-versions.sh
git commit -m "ci: sync pycardano version into requirements.txt files"
```

---

## Task 8: Add pycardano to local-test-offchain.sh

**Files:**
- Modify: `scripts/local-test-offchain.sh`

- [ ] **Step 1: Add counters**

Locate the counter block (around lines 53-62 of the current file). Add `PYCARDANO_*` counters next to the existing ones:

```bash
EVOSDK_TOTAL=0
EVOSDK_PASSED=0
EVOSDK_FAILED=0
PYCARDANO_TOTAL=0
PYCARDANO_PASSED=0
PYCARDANO_FAILED=0
```

- [ ] **Step 2: Add the PyCardano test block**

After the existing `# Test Evolution SDK examples` block (ending with the `done < <(find . -maxdepth 4 -path "*/offchain/evolutionsdk/deno.json" -type f | sort)` line) and before the `# Print summary` heading, insert:

```bash
# Test PyCardano examples
echo ""
echo -e "${BLUE}Testing PyCardano Examples${NC}"
echo "----------------------------------------"

if ! command -v python3 &> /dev/null; then
  echo -e "${RED}❌ Python is not installed. Skipping PyCardano tests.${NC}"
else
  PY_VERSION=$(python3 --version 2>&1)
  echo "Python version: $PY_VERSION"
  echo ""

  while IFS= read -r req_file; do
    if [[ ! -f "$req_file" ]]; then
      continue
    fi

    DIR=$(dirname "$req_file")
    EXAMPLE=$(echo "$DIR" | cut -d'/' -f2)

    PYCARDANO_TOTAL=$((PYCARDANO_TOTAL + 1))

    echo -e "${YELLOW}📦 [$PYCARDANO_TOTAL] Testing: $EXAMPLE${NC}"
    echo "   Path: $DIR"

    PY_FILE=$(find "$DIR" -maxdepth 1 -name "*.py" -type f | head -1)
    if [[ -z "$PY_FILE" ]]; then
      echo -e "   ${RED}❌ No Python file found${NC}"
      PYCARDANO_FAILED=$((PYCARDANO_FAILED + 1))
      echo "skipped" > "$RESULTS_DIR/pycardano-$EXAMPLE-status.txt"
      echo ""
      continue
    fi

    PY_FILENAME=$(basename "$PY_FILE")
    echo "   File: $PY_FILENAME"

    PLUTUS_JSON="$EXAMPLE/onchain/aiken/plutus.json"
    if [[ ! -f "$PLUTUS_JSON" ]]; then
      echo -e "   ${YELLOW}⚠️  plutus.json not found, building Aiken first...${NC}"
      if [[ -f "$EXAMPLE/onchain/aiken/aiken.toml" ]]; then
        (cd "$EXAMPLE/onchain/aiken" && aiken build > /dev/null 2>&1)
      fi
    fi

    VENV_DIR="$DIR/.venv-local"
    if [[ ! -d "$VENV_DIR" ]]; then
      python3 -m venv "$VENV_DIR"
    fi
    # shellcheck source=/dev/null
    source "$VENV_DIR/bin/activate"
    pip install --quiet --upgrade pip
    pip install --quiet -r "$req_file"

    cd "$DIR"
    echo "   Running test (timeout: 300s, press Ctrl+C to skip)..."
    echo "   Output:"
    echo ""

    if timeout --foreground 300 python "$PY_FILENAME" 2>&1 | tee "$REPO_ROOT/$RESULTS_DIR/pycardano-$EXAMPLE.log"; then
      EXIT_CODE=0
    else
      EXIT_CODE=$?
    fi
    echo ""
    deactivate
    cd "$REPO_ROOT"

    if [[ $EXIT_CODE -eq 0 ]]; then
      PYCARDANO_PASSED=$((PYCARDANO_PASSED + 1))
      echo -e "   ${GREEN}✅ PASSED${NC}"
      echo "success" > "$RESULTS_DIR/pycardano-$EXAMPLE-status.txt"
    elif [[ $EXIT_CODE -eq 124 ]]; then
      PYCARDANO_FAILED=$((PYCARDANO_FAILED + 1))
      echo -e "   ${RED}❌ TIMEOUT (>300s)${NC}"
      echo "timeout" > "$RESULTS_DIR/pycardano-$EXAMPLE-status.txt"
    else
      PYCARDANO_FAILED=$((PYCARDANO_FAILED + 1))
      echo -e "   ${RED}❌ FAILED (exit code: $EXIT_CODE)${NC}"
      echo "   Last 10 lines of output:"
      tail -10 "$RESULTS_DIR/pycardano-$EXAMPLE.log" | sed 's/^/   | /'
      echo "failed" > "$RESULTS_DIR/pycardano-$EXAMPLE-status.txt"
    fi

    echo ""

  done < <(find . -maxdepth 4 -path "*/offchain/pycardano/requirements.txt" -type f | sort)
fi
```

- [ ] **Step 3: Add to the summary section**

Inside the `Print summary` block (after the `EVOSDK_TOTAL` summary block), insert:

```bash
if [[ $PYCARDANO_TOTAL -gt 0 ]]; then
  echo "PyCardano:"
  echo "  Total:   $PYCARDANO_TOTAL"
  echo -e "  ${GREEN}Passed:  $PYCARDANO_PASSED ✅${NC}"
  echo -e "  ${RED}Failed:  $PYCARDANO_FAILED ❌${NC}"
  echo ""
fi
```

Then update the `TOTAL_FAILED` line:

```bash
TOTAL_FAILED=$((CCL_FAILED + MESH_FAILED + EVOSDK_FAILED + PYCARDANO_FAILED))
```

- [ ] **Step 4: Quick syntax check**

Run: `bash -n scripts/local-test-offchain.sh && echo OK`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add scripts/local-test-offchain.sh
git commit -m "ci: extend local-test-offchain.sh with pycardano runner"
```

---

## Task 9: Implement `simple-transfer` for PyCardano

**Files:**
- Create: `simple-transfer/offchain/pycardano/requirements.txt`
- Create: `simple-transfer/offchain/pycardano/simple_transfer.py`
- Create: `simple-transfer/offchain/pycardano/README.md`

- [ ] **Step 1: Create `requirements.txt`**

```text
pycardano==0.19.2
```

- [ ] **Step 2: Create `simple_transfer.py`**

The validator has one parameter (`receiver: VerificationKeyHash`) and only accepts the spend if the receiver signed. Scenario: fund account 1 from account 0, account 0 locks 10 ADA at the script (parameterised on account 1's VKH), account 1 claims.

```python
"""Simple-transfer: parameterised PlutusV3 spend; only the receiver can unlock."""
import json
import time
from pathlib import Path

from pycardano import (
    Address,
    BlockFrostChainContext,
    ExtendedSigningKey,
    HDWallet,
    Network,
    PlutusData,
    PlutusV3Script,
    Redeemer,
    TransactionBuilder,
    TransactionOutput,
    Unit,
    plutus_script_hash,
)
from pycardano.utils import script_data_hash  # noqa: F401  (kept for parity)
import cbor2

YACI_URL = "http://localhost:8080/api/v1"
NETWORK = Network.TESTNET
TEST_MNEMONIC = (
    "test test test test test test test test test test test test "
    "test test test test test test test test test test test sauce"
)
BLUEPRINT_PATH = Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json"


def context() -> BlockFrostChainContext:
    return BlockFrostChainContext(project_id="Dummy Key", base_url=YACI_URL)


def wallet_at(account_index: int) -> tuple[ExtendedSigningKey, ExtendedSigningKey, Address]:
    hd = HDWallet.from_mnemonic(TEST_MNEMONIC)
    payment_hd = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/0/0")
    stake_hd = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/2/0")
    psk = ExtendedSigningKey.from_hdwallet(payment_hd)
    ssk = ExtendedSigningKey.from_hdwallet(stake_hd)
    addr = Address(
        payment_part=psk.to_verification_key().hash(),
        staking_part=ssk.to_verification_key().hash(),
        network=NETWORK,
    )
    return psk, ssk, addr


def load_validator_cbor(title_prefix: str) -> bytes:
    blueprint = json.loads(BLUEPRINT_PATH.read_text())
    v = next(x for x in blueprint["validators"] if x["title"].startswith(title_prefix))
    return bytes.fromhex(v["compiledCode"])


def apply_param_vkh(compiled_code: bytes, vkh_hex: str) -> PlutusV3Script:
    """Apply one bytes parameter to a parameterised compiled-code blob.

    Aiken emits the compiled code as a double-CBOR-wrapped bytestring.
    pycardano expects `PlutusV3Script` as the inner (single-wrapped) bytes.
    We decode once, splice the parameter into the program preamble using
    pycardano's helper, and re-wrap.
    """
    from pycardano.plutus import script_hash  # noqa: F401
    # Use uplc-via-cbor2: programs are CBOR-tagged bytes; pycardano's
    # `cbor2.loads` strips the outer wrapper.
    inner = cbor2.loads(compiled_code)
    # apply_params_to_script: pycardano>=0.10 ships `pycardano.uplc.apply_params`.
    from pycardano.uplc import apply_params_to_script
    applied = apply_params_to_script([bytes.fromhex(vkh_hex)], inner)
    return PlutusV3Script(cbor2.dumps(applied))


def script_address(script: PlutusV3Script) -> Address:
    return Address(payment_part=plutus_script_hash(script), network=NETWORK)


def fund_from_account0(target: Address, lovelace: int) -> None:
    ctx = context()
    psk, _ssk, addr = wallet_at(0)
    builder = TransactionBuilder(ctx)
    builder.add_input_address(addr)
    builder.add_output(TransactionOutput(target, lovelace))
    signed = builder.build_and_sign([psk], change_address=addr)
    ctx.submit_tx(signed)
    print(f"Funded {target} with {lovelace} lovelace. tx={signed.id}")
    # Wait for the funded utxo to land before the next caller queries.
    for _ in range(60):
        try:
            if ctx.utxos(str(target)):
                return
        except Exception:
            pass
        time.sleep(1)


def lock(sender_idx: int, receiver: Address, lovelace: int) -> Address:
    ctx = context()
    psk, _ssk, sender_addr = wallet_at(sender_idx)
    receiver_vkh_hex = receiver.payment_part.payload.hex()
    raw = load_validator_cbor("simple_transfer.simpleTransfer.spend")
    script = apply_param_vkh(raw, receiver_vkh_hex)
    s_addr = script_address(script)

    builder = TransactionBuilder(ctx)
    builder.add_input_address(sender_addr)
    builder.add_output(TransactionOutput(s_addr, lovelace))
    signed = builder.build_and_sign([psk], change_address=sender_addr)
    ctx.submit_tx(signed)
    print(f"LOCK ok. {lovelace} lovelace to {s_addr}. tx={signed.id}")
    return s_addr


def claim(receiver_idx: int) -> None:
    ctx = context()
    psk, _ssk, receiver_addr = wallet_at(receiver_idx)
    receiver_vkh_hex = receiver_addr.payment_part.payload.hex()
    raw = load_validator_cbor("simple_transfer.simpleTransfer.spend")
    script = apply_param_vkh(raw, receiver_vkh_hex)
    s_addr = script_address(script)

    # Wait until the locked UTxO exists at the script address.
    for _ in range(60):
        utxos = ctx.utxos(str(s_addr))
        if utxos:
            break
        time.sleep(1)
    else:
        raise TimeoutError(f"No UTxOs found at {s_addr}")

    builder = TransactionBuilder(ctx)
    for u in utxos:
        builder.add_script_input(u, script=script, redeemer=Redeemer(Unit()))
    builder.add_input_address(receiver_addr)
    builder.required_signers = [receiver_addr.payment_part]
    signed = builder.build_and_sign([psk], change_address=receiver_addr)
    ctx.submit_tx(signed)
    print(f"CLAIM ok. {len(utxos)} UTxO(s). tx={signed.id}")


def run_scenario() -> None:
    print("=== simple-transfer scenario: lock → claim ===")
    _, _, recipient_addr = wallet_at(1)
    fund_from_account0(recipient_addr, 25_000_000)
    lock(sender_idx=0, receiver=recipient_addr, lovelace=10_000_000)
    claim(receiver_idx=1)
    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()
```

> Note for the implementing agent: PyCardano's parameter-application API has shifted across versions. If `pycardano.uplc.apply_params_to_script` isn't available in 0.19.2, use `pycardano.plutus.apply_params_to_script` (the public re-export) or fall back to `from uplc.tools import apply_parameter` from the `uplc` dependency, which PyCardano installs transitively. Verify with `python -c "from pycardano.plutus import apply_params_to_script; print(apply_params_to_script)"` before writing the script body — adjust the import line if needed.

- [ ] **Step 3: Create `README.md`**

```markdown
# Simple Transfer (PyCardano)

PyCardano implementation of the simple-transfer use case: lock funds for a
specific receiver using the parameterised Aiken `simpleTransfer` validator;
only the receiver's signature can unlock them.

## Prerequisites

- Python 3.11+
- [Aiken](https://aiken-lang.org/) (to build `plutus.json`)
- [Yaci DevKit](https://github.com/bloxbean/yaci-devkit) running locally
  on port `8080`

## Setup

```bash
# 1. Build the Aiken contract
(cd ../../onchain/aiken && aiken build)

# 2. Start yaci-devkit (in a separate shell)
yaci-devkit up --enable-yaci-store

# 3. Install Python deps
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
python simple_transfer.py
```

The script funds account 1 from account 0, locks 10 ADA at a script
parameterised by account 1's payment key hash, then has account 1 claim
the UTxO. Exits 0 on success.
```

- [ ] **Step 4: Local smoke test**

Bring up yaci-devkit (`yaci-devkit up --enable-yaci-store`) and `aiken build` in `simple-transfer/onchain/aiken/`, then:

```bash
cd simple-transfer/offchain/pycardano
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python simple_transfer.py
```

Expected: prints `LOCK ok. ...` then `CLAIM ok. ...` then `=== Scenario complete ===`; exit code 0.

If the run fails because of PyCardano API differences (the parameter-application API in particular has moved between minor versions), fix the import in `simple_transfer.py` and rerun. Do **not** change the validator or the scenario shape.

- [ ] **Step 5: Verify discovery picks the example up**

Run: `bash scripts/local-test-discovery.sh`
Expected: among the lines under `Scanning for PyCardano examples...`, see `- simple-transfer`.

- [ ] **Step 6: Commit**

```bash
git add simple-transfer/offchain/pycardano/
git commit -m "feat(pycardano): simple-transfer implementation"
```

---

## Task 10: Implement `vesting` for PyCardano

**Files:**
- Create: `vesting/offchain/pycardano/requirements.txt`
- Create: `vesting/offchain/pycardano/vesting.py`
- Create: `vesting/offchain/pycardano/README.md`

The validator has **no** parameters; it reads `VestingDatum { lock_until, owner, beneficiary }` and accepts either owner signature, or beneficiary signature + `valid_after(lock_until)`.

Scenario (mirrors the Evolution SDK reference):

1. account 0 = owner/funder, account 1 = beneficiary.
2. Fund account 1 from 0.
3. Deposit 5 ADA with a far-future `lock_until` (one hour ahead) — this UTxO will be reclaimed by the owner.
4. Deposit 5 ADA with a short `lock_until` (~10 slots ahead) — this UTxO will be claimed by the beneficiary after the deadline.
5. Owner withdraws the first.
6. Wait for the chain tip to pass `lock_until` of the second.
7. Beneficiary withdraws the second with `valid_after`.

- [ ] **Step 1: Create `requirements.txt`**

```text
pycardano==0.19.2
```

- [ ] **Step 2: Create `vesting.py`**

```python
"""Vesting: owner can always clawback; beneficiary can withdraw after lock_until."""
import json
import time
from dataclasses import dataclass
from pathlib import Path

import cbor2
import requests

from pycardano import (
    Address,
    BlockFrostChainContext,
    DatumHash,
    ExtendedSigningKey,
    HDWallet,
    Network,
    PlutusData,
    PlutusV3Script,
    Redeemer,
    TransactionBuilder,
    TransactionOutput,
    Unit,
    plutus_script_hash,
)

YACI_URL = "http://localhost:8080/api/v1"
NETWORK = Network.TESTNET
TEST_MNEMONIC = (
    "test test test test test test test test test test test test "
    "test test test test test test test test test test test sauce"
)
BLUEPRINT_PATH = Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json"
ERA_OFFSET_SECONDS = 600


@dataclass
class VestingDatum(PlutusData):
    CONSTR_ID = 0
    lock_until: int
    owner: bytes
    beneficiary: bytes


def context() -> BlockFrostChainContext:
    return BlockFrostChainContext(project_id="Dummy Key", base_url=YACI_URL)


def wallet_at(account_index: int) -> tuple[ExtendedSigningKey, ExtendedSigningKey, Address]:
    hd = HDWallet.from_mnemonic(TEST_MNEMONIC)
    p = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/0/0")
    s = hd.derive_from_path(f"m/1852'/1815'/{account_index}'/2/0")
    psk = ExtendedSigningKey.from_hdwallet(p)
    ssk = ExtendedSigningKey.from_hdwallet(s)
    addr = Address(
        payment_part=psk.to_verification_key().hash(),
        staking_part=ssk.to_verification_key().hash(),
        network=NETWORK,
    )
    return psk, ssk, addr


def load_script() -> PlutusV3Script:
    blueprint = json.loads(BLUEPRINT_PATH.read_text())
    v = next(x for x in blueprint["validators"] if x["title"].startswith("vesting.vesting.spend"))
    raw = bytes.fromhex(v["compiledCode"])
    # No parameters → just unwrap the outer CBOR and re-wrap as PlutusV3Script.
    return PlutusV3Script(raw)


def script_address(script: PlutusV3Script) -> Address:
    return Address(payment_part=plutus_script_hash(script), network=NETWORK)


def yaci_block_latest() -> dict:
    return requests.get(f"{YACI_URL}/blocks/latest", timeout=10).json()


def slot_config() -> tuple[int, int, int]:
    """Return (zero_time_ms, zero_slot, slot_length_ms).

    yaci-devkit boots through several "instant" eras and enters Babbage at
    relative slot/time 600s; pre-bake the offset so wall-clock ms maps to
    Plutus POSIX ms reliably.
    """
    b = yaci_block_latest()
    zero_time = (b["time"] - b["slot"] + ERA_OFFSET_SECONDS) * 1000
    return zero_time, 0, 1000


def slot_to_ms(slot: int) -> int:
    z, zs, sl = slot_config()
    return z + (slot - zs) * sl


def ms_to_slot(ms: int) -> int:
    z, zs, sl = slot_config()
    return (ms - z) // sl + zs


def fund_from_account0(target: Address, lovelace: int) -> None:
    ctx = context()
    psk, _, addr = wallet_at(0)
    b = TransactionBuilder(ctx)
    b.add_input_address(addr)
    b.add_output(TransactionOutput(target, lovelace))
    signed = b.build_and_sign([psk], change_address=addr)
    ctx.submit_tx(signed)
    print(f"Funded {target} with {lovelace}. tx={signed.id}")
    for _ in range(60):
        if ctx.utxos(str(target)):
            return
        time.sleep(1)


def deposit(owner_idx: int, beneficiary_vkh: bytes, lovelace: int, lock_until_ms: int) -> str:
    ctx = context()
    psk, _, owner_addr = wallet_at(owner_idx)
    script = load_script()
    s_addr = script_address(script)
    datum = VestingDatum(
        lock_until=lock_until_ms,
        owner=owner_addr.payment_part.payload,
        beneficiary=beneficiary_vkh,
    )
    b = TransactionBuilder(ctx)
    b.add_input_address(owner_addr)
    b.add_output(TransactionOutput(s_addr, lovelace, datum=datum))
    signed = b.build_and_sign([psk], change_address=owner_addr)
    ctx.submit_tx(signed)
    print(f"DEPOSIT ok. lockUntilMs={lock_until_ms} tx={signed.id}")
    return str(signed.id)


def find_vesting_utxo(tx_hash: str, s_addr: Address):
    ctx = context()
    for _ in range(60):
        for u in ctx.utxos(str(s_addr)):
            if str(u.input.transaction_id) == tx_hash and u.output.datum is not None:
                return u
        time.sleep(1)
    raise TimeoutError(f"Vesting UTxO from {tx_hash} not found at {s_addr}")


def withdraw_as_owner(owner_idx: int, tx_hash: str) -> None:
    ctx = context()
    psk, _, owner_addr = wallet_at(owner_idx)
    script = load_script()
    s_addr = script_address(script)
    utxo = find_vesting_utxo(tx_hash, s_addr)

    b = TransactionBuilder(ctx)
    b.add_script_input(utxo, script=script, redeemer=Redeemer(Unit()))
    b.add_input_address(owner_addr)
    b.required_signers = [owner_addr.payment_part]
    signed = b.build_and_sign([psk], change_address=owner_addr)
    ctx.submit_tx(signed)
    print(f"WITHDRAW (owner) ok. tx={signed.id}")


def withdraw_as_beneficiary(ben_idx: int, tx_hash: str, lock_until_ms: int) -> None:
    ctx = context()
    psk, _, ben_addr = wallet_at(ben_idx)
    script = load_script()
    s_addr = script_address(script)
    utxo = find_vesting_utxo(tx_hash, s_addr)

    tip_slot = yaci_block_latest()["slot"]
    lock_slot = ms_to_slot(lock_until_ms)
    valid_from = max(lock_slot + 1, tip_slot - 5)
    valid_to = valid_from + 120

    b = TransactionBuilder(ctx)
    b.add_script_input(utxo, script=script, redeemer=Redeemer(Unit()))
    b.add_input_address(ben_addr)
    b.required_signers = [ben_addr.payment_part]
    b.validity_start = valid_from
    b.ttl = valid_to
    signed = b.build_and_sign([psk], change_address=ben_addr)
    ctx.submit_tx(signed)
    print(f"WITHDRAW (beneficiary) ok. tx={signed.id}")


def run_scenario() -> None:
    print("=== vesting scenario: deposit×2 → owner-withdraw / beneficiary-withdraw ===")
    _, _, owner_addr = wallet_at(0)
    _, _, ben_addr = wallet_at(1)
    fund_from_account0(ben_addr, 20_000_000)

    lock_far = int((time.time() + 60 * 60) * 1000)
    tx1 = deposit(0, ben_addr.payment_part.payload, 5_000_000, lock_far)
    time.sleep(2)

    tip_slot = yaci_block_latest()["slot"]
    lock_short = slot_to_ms(tip_slot + 10)
    tx2 = deposit(0, ben_addr.payment_part.payload, 5_000_000, lock_short)
    time.sleep(2)

    withdraw_as_owner(0, tx1)

    lock_slot = ms_to_slot(lock_short)
    for i in range(300):
        tip = yaci_block_latest()["slot"]
        if tip > lock_slot:
            print(f"tipSlot {tip} > lockUntilSlot {lock_slot}, proceeding")
            break
        if i % 10 == 0:
            print(f"Waiting for chain slot {tip} → {lock_slot}…")
        time.sleep(1)

    withdraw_as_beneficiary(1, tx2, lock_short)
    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()
```

- [ ] **Step 3: Create `README.md`**

```markdown
# Vesting (PyCardano)

Vesting use case: owner can always clawback funds; the beneficiary can
only collect after `lock_until` (POSIX milliseconds) has passed.

## Prerequisites

- Python 3.11+
- Aiken (to build `plutus.json`)
- Yaci DevKit running on port `8080`

## Run

```bash
(cd ../../onchain/aiken && aiken build)
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python vesting.py
```

The script deposits twice, demonstrates the owner clawback path on the
first UTxO, waits for the short lock to pass, then exercises the
beneficiary path on the second.
```

- [ ] **Step 4: Local smoke test**

```bash
cd vesting/offchain/pycardano
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python vesting.py
```

Expected: `=== Scenario complete ===` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add vesting/offchain/pycardano/
git commit -m "feat(pycardano): vesting implementation"
```

---

## Task 11: Implement `htlc` for PyCardano

**Files:**
- Create: `htlc/offchain/pycardano/requirements.txt`
- Create: `htlc/offchain/pycardano/htlc.py`
- Create: `htlc/offchain/pycardano/README.md`

The validator has three parameters: `(secret: ByteArray, expiration: Int, owner: VerificationKeyHash)` and two redeemer variants: `GUESS { answer: ByteArray }` (Constr index 0) and `WITHDRAW` (Constr index 1).

Scenario:
1. account 0 = owner/funder, account 1 = claimer.
2. Fund account 1 from 0.
3. Init UTxO 1 with secret `"open-sesame"` and far-future expiration; locks 10 ADA.
4. Init UTxO 2 with secret `"another-secret"` and short expiration (~10 slots out); locks 8 ADA.
5. account 1 claims UTxO 1 by revealing `secret1` → GUESS redeemer.
6. Wait for chain tip past UTxO 2's expiration.
7. account 0 refunds UTxO 2 via WITHDRAW redeemer with `valid_after`.

- [ ] **Step 1: Create `requirements.txt`**

```text
pycardano==0.19.2
```

- [ ] **Step 2: Create `htlc.py`**

```python
"""HTLC: claim by preimage (GUESS); owner refund after expiry (WITHDRAW)."""
import hashlib
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cbor2
import requests

from pycardano import (
    Address,
    BlockFrostChainContext,
    ExtendedSigningKey,
    HDWallet,
    Network,
    PlutusData,
    PlutusV3Script,
    Redeemer,
    TransactionBuilder,
    TransactionOutput,
    Unit,
    plutus_script_hash,
)
from pycardano.plutus import apply_params_to_script  # adjust if API import path differs

YACI_URL = "http://localhost:8080/api/v1"
NETWORK = Network.TESTNET
TEST_MNEMONIC = (
    "test test test test test test test test test test test test "
    "test test test test test test test test test test test sauce"
)
BLUEPRINT_PATH = Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json"
ERA_OFFSET_SECONDS = 600


@dataclass
class Guess(PlutusData):
    CONSTR_ID = 0
    answer: bytes


@dataclass
class Withdraw(PlutusData):
    CONSTR_ID = 1


def context() -> BlockFrostChainContext:
    return BlockFrostChainContext(project_id="Dummy Key", base_url=YACI_URL)


def wallet_at(idx: int) -> tuple[ExtendedSigningKey, ExtendedSigningKey, Address]:
    hd = HDWallet.from_mnemonic(TEST_MNEMONIC)
    p = ExtendedSigningKey.from_hdwallet(hd.derive_from_path(f"m/1852'/1815'/{idx}'/0/0"))
    s = ExtendedSigningKey.from_hdwallet(hd.derive_from_path(f"m/1852'/1815'/{idx}'/2/0"))
    return p, s, Address(
        payment_part=p.to_verification_key().hash(),
        staking_part=s.to_verification_key().hash(),
        network=NETWORK,
    )


def load_validator_cbor() -> bytes:
    blueprint = json.loads(BLUEPRINT_PATH.read_text())
    v = next(x for x in blueprint["validators"] if x["title"].startswith("htlc.htlc.spend"))
    return bytes.fromhex(v["compiledCode"])


def build_script(secret_hash_hex: str, expiration_ms: int, owner_vkh_hex: str) -> PlutusV3Script:
    raw = load_validator_cbor()
    inner = cbor2.loads(raw)
    applied = apply_params_to_script(
        [bytes.fromhex(secret_hash_hex), expiration_ms, bytes.fromhex(owner_vkh_hex)],
        inner,
    )
    return PlutusV3Script(cbor2.dumps(applied))


def script_address(script: PlutusV3Script) -> Address:
    return Address(payment_part=plutus_script_hash(script), network=NETWORK)


def yaci_block_latest() -> dict[str, Any]:
    return requests.get(f"{YACI_URL}/blocks/latest", timeout=10).json()


def slot_config() -> tuple[int, int, int]:
    b = yaci_block_latest()
    return (b["time"] - b["slot"] + ERA_OFFSET_SECONDS) * 1000, 0, 1000


def slot_to_ms(s: int) -> int:
    z, zs, sl = slot_config()
    return z + (s - zs) * sl


def ms_to_slot(ms: int) -> int:
    z, zs, sl = slot_config()
    return (ms - z) // sl + zs


def fund_from_account0(target: Address, lovelace: int) -> None:
    ctx = context()
    psk, _, addr = wallet_at(0)
    b = TransactionBuilder(ctx)
    b.add_input_address(addr)
    b.add_output(TransactionOutput(target, lovelace))
    signed = b.build_and_sign([psk], change_address=addr)
    ctx.submit_tx(signed)
    print(f"Funded {target}. tx={signed.id}")
    for _ in range(60):
        if ctx.utxos(str(target)):
            return
        time.sleep(1)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def init(owner_idx: int, secret: str, expiration_ms: int, lovelace: int) -> tuple[str, str]:
    ctx = context()
    psk, _, owner_addr = wallet_at(owner_idx)
    secret_hash = sha256_hex(secret)
    owner_vkh = owner_addr.payment_part.payload.hex()
    script = build_script(secret_hash, expiration_ms, owner_vkh)
    s_addr = script_address(script)

    b = TransactionBuilder(ctx)
    b.add_input_address(owner_addr)
    b.add_output(TransactionOutput(s_addr, lovelace, datum=Unit()))
    signed = b.build_and_sign([psk], change_address=owner_addr)
    ctx.submit_tx(signed)
    print(f"INIT ok. secretHash={secret_hash[:12]}… tx={signed.id}")
    return str(signed.id), secret_hash


def find_locked(tx_hash: str, s_addr: Address):
    ctx = context()
    for _ in range(60):
        for u in ctx.utxos(str(s_addr)):
            if str(u.input.transaction_id) == tx_hash:
                return u
        time.sleep(1)
    raise TimeoutError(f"Locked UTxO {tx_hash} not at {s_addr}")


def claim(claimer_idx: int, secret: str, secret_hash: str, expiration_ms: int, owner_vkh_hex: str, tx_hash: str) -> None:
    ctx = context()
    psk, _, addr = wallet_at(claimer_idx)
    script = build_script(secret_hash, expiration_ms, owner_vkh_hex)
    s_addr = script_address(script)
    utxo = find_locked(tx_hash, s_addr)

    b = TransactionBuilder(ctx)
    b.add_script_input(utxo, script=script, redeemer=Redeemer(Guess(answer=secret.encode("utf-8"))))
    b.add_input_address(addr)
    b.required_signers = [addr.payment_part]
    signed = b.build_and_sign([psk], change_address=addr)
    ctx.submit_tx(signed)
    print(f"CLAIM ok. tx={signed.id}")


def refund(owner_idx: int, secret_hash: str, expiration_ms: int, owner_vkh_hex: str, tx_hash: str) -> None:
    ctx = context()
    psk, _, addr = wallet_at(owner_idx)
    script = build_script(secret_hash, expiration_ms, owner_vkh_hex)
    s_addr = script_address(script)
    utxo = find_locked(tx_hash, s_addr)

    exp_slot = ms_to_slot(expiration_ms)
    tip = yaci_block_latest()["slot"]
    valid_from = max(exp_slot + 1, tip - 5)
    valid_to = valid_from + 120

    b = TransactionBuilder(ctx)
    b.add_script_input(utxo, script=script, redeemer=Redeemer(Withdraw()))
    b.add_input_address(addr)
    b.required_signers = [addr.payment_part]
    b.validity_start = valid_from
    b.ttl = valid_to
    signed = b.build_and_sign([psk], change_address=addr)
    ctx.submit_tx(signed)
    print(f"REFUND ok. tx={signed.id}")


def run_scenario() -> None:
    print("=== htlc scenario: init×2 → claim (correct secret) / refund (after expiry) ===")
    _, _, owner_addr = wallet_at(0)
    _, _, claimer_addr = wallet_at(1)
    owner_vkh = owner_addr.payment_part.payload.hex()
    fund_from_account0(claimer_addr, 20_000_000)

    secret1 = "open-sesame"
    exp1 = int((time.time() + 60 * 60) * 1000)
    tx1, h1 = init(0, secret1, exp1, 10_000_000)
    time.sleep(2)

    tip_slot = yaci_block_latest()["slot"]
    exp2_slot = tip_slot + 10
    exp2 = slot_to_ms(exp2_slot)
    secret2 = "another-secret"
    tx2, h2 = init(0, secret2, exp2, 8_000_000)
    time.sleep(2)

    claim(1, secret1, h1, exp1, owner_vkh, tx1)

    for i in range(300):
        tip = yaci_block_latest()["slot"]
        if tip > exp2_slot:
            print(f"tipSlot {tip} > exp2Slot {exp2_slot}, proceeding")
            break
        if i % 10 == 0:
            print(f"Waiting for chain slot {tip} → {exp2_slot}…")
        time.sleep(1)

    refund(0, h2, exp2, owner_vkh, tx2)
    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()
```

- [ ] **Step 3: Create `README.md`**

```markdown
# HTLC (PyCardano)

Hash-Timelock Contract. The Aiken validator is parameterised by
`(secret_hash, expiration_ms, owner_vkh)`. The script accepts a
`GUESS { answer }` redeemer that produces the SHA-256 preimage, or a
`WITHDRAW` redeemer used by the owner after `expiration`.

## Prerequisites

- Python 3.11+
- Aiken (to build `plutus.json`)
- Yaci DevKit running on port `8080`

## Run

```bash
(cd ../../onchain/aiken && aiken build)
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python htlc.py
```

The script locks twice (long and short expiry), claims the long one by
preimage, waits for the short one to expire, then refunds it.
```

- [ ] **Step 4: Local smoke test**

```bash
cd htlc/offchain/pycardano
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python htlc.py
```

Expected: `=== Scenario complete ===` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add htlc/offchain/pycardano/
git commit -m "feat(pycardano): htlc implementation"
```

---

## Task 12: Implement `token-transfer` for PyCardano

**Files:**
- Create: `token-transfer/offchain/pycardano/requirements.txt`
- Create: `token-transfer/offchain/pycardano/token_transfer.py`
- Create: `token-transfer/offchain/pycardano/README.md`

The validator takes `(receiver: VerificationKeyHash, policy: PolicyId, assetName: ByteArray)`. The Evolution SDK reference uses a tiny always-true PlutusV3 script (CBOR hex `46450101002499`) as the minting policy and `TestAsset` as the asset name. We reuse the same trick.

Scenario:
1. Generate a fresh mnemonic so the wallet starts asset-free (the validator inspects outputs for stray tokens).
2. Fund the fresh wallet from account 0.
3. Mint 10 `TestAsset` tokens under the always-true policy → wallet.
4. Lock all 10 at the script (parameterised on the wallet's VKH + policy + asset name).
5. Unlock back to the wallet, satisfying the receiver-signature + no-foreign-asset constraints.

- [ ] **Step 1: Create `requirements.txt`**

```text
pycardano==0.19.2
```

- [ ] **Step 2: Create `token_transfer.py`**

```python
"""Token-transfer: parameterised spend over (receiver, policy, assetName)."""
import json
import secrets
import time
from pathlib import Path

import cbor2

from pycardano import (
    Address,
    AssetName,
    BlockFrostChainContext,
    ExtendedSigningKey,
    HDWallet,
    MultiAsset,
    Network,
    PlutusV3Script,
    Redeemer,
    ScriptHash,
    TransactionBuilder,
    TransactionOutput,
    Unit,
    Value,
    plutus_script_hash,
)
from pycardano.plutus import apply_params_to_script  # adjust if import path differs

YACI_URL = "http://localhost:8080/api/v1"
NETWORK = Network.TESTNET
TEST_MNEMONIC = (
    "test test test test test test test test test test test test "
    "test test test test test test test test test test test sauce"
)
BLUEPRINT_PATH = Path(__file__).resolve().parents[2] / "onchain" / "aiken" / "plutus.json"
ASSET_NAME = b"TestAsset"
ALWAYS_TRUE_SCRIPT = PlutusV3Script(bytes.fromhex("46450101002499"))


def context() -> BlockFrostChainContext:
    return BlockFrostChainContext(project_id="Dummy Key", base_url=YACI_URL)


def wallet_from(mnemonic: str, idx: int = 0) -> tuple[ExtendedSigningKey, ExtendedSigningKey, Address]:
    hd = HDWallet.from_mnemonic(mnemonic)
    p = ExtendedSigningKey.from_hdwallet(hd.derive_from_path(f"m/1852'/1815'/{idx}'/0/0"))
    s = ExtendedSigningKey.from_hdwallet(hd.derive_from_path(f"m/1852'/1815'/{idx}'/2/0"))
    return p, s, Address(
        payment_part=p.to_verification_key().hash(),
        staking_part=s.to_verification_key().hash(),
        network=NETWORK,
    )


def fresh_mnemonic() -> str:
    """Generate a 24-word BIP-39 mnemonic via pycardano's HDWallet."""
    return HDWallet.generate(24).mnemonic


def load_spend_cbor() -> bytes:
    blueprint = json.loads(BLUEPRINT_PATH.read_text())
    v = next(x for x in blueprint["validators"] if x["title"].startswith("token_transfer.token_transfer.spend"))
    return bytes.fromhex(v["compiledCode"])


def build_spend(receiver_vkh: bytes, policy_id: bytes, asset_name: bytes) -> PlutusV3Script:
    raw = load_spend_cbor()
    inner = cbor2.loads(raw)
    applied = apply_params_to_script([receiver_vkh, policy_id, asset_name], inner)
    return PlutusV3Script(cbor2.dumps(applied))


def script_address(script: PlutusV3Script) -> Address:
    return Address(payment_part=plutus_script_hash(script), network=NETWORK)


def fund_from_account0(target: Address, lovelace: int) -> None:
    ctx = context()
    psk, _, addr = wallet_from(TEST_MNEMONIC, 0)
    b = TransactionBuilder(ctx)
    b.add_input_address(addr)
    b.add_output(TransactionOutput(target, lovelace))
    signed = b.build_and_sign([psk], change_address=addr)
    ctx.submit_tx(signed)
    print(f"Funded {target} with {lovelace}. tx={signed.id}")
    for _ in range(60):
        if ctx.utxos(str(target)):
            return
        time.sleep(1)


def mint(mnemonic: str) -> tuple[bytes, bytes]:
    """Mint 10 TestAsset under the always-true policy; return (policy_id, asset_name)."""
    ctx = context()
    psk, _, addr = wallet_from(mnemonic)
    policy_id = plutus_script_hash(ALWAYS_TRUE_SCRIPT).payload
    asset = MultiAsset.from_primitive({policy_id: {ASSET_NAME: 10}})

    b = TransactionBuilder(ctx)
    b.add_input_address(addr)
    b.mint = asset
    b.add_minting_script(ALWAYS_TRUE_SCRIPT, redeemer=Redeemer(Unit()))
    b.add_output(TransactionOutput(addr, Value(2_000_000, asset)))
    signed = b.build_and_sign([psk], change_address=addr)
    ctx.submit_tx(signed)
    print(f"MINT ok. policy={policy_id.hex()[:12]}… tx={signed.id}")
    return policy_id, ASSET_NAME


def lock(mnemonic: str, policy_id: bytes, asset_name: bytes) -> Address:
    ctx = context()
    psk, _, addr = wallet_from(mnemonic)
    script = build_spend(addr.payment_part.payload, policy_id, asset_name)
    s_addr = script_address(script)

    # Find UTxO holding the asset.
    target = None
    for _ in range(60):
        for u in ctx.utxos(str(addr)):
            mas = u.output.amount.multi_asset
            if policy_id in mas.data and AssetName(asset_name) in mas.data[policy_id]:
                target = u
                break
        if target:
            break
        time.sleep(1)
    if not target:
        raise RuntimeError("No wallet UTxO with the minted token")
    amt = target.output.amount.multi_asset.data[policy_id][AssetName(asset_name)]

    out_assets = MultiAsset.from_primitive({policy_id: {asset_name: amt}})
    b = TransactionBuilder(ctx)
    b.add_input(target)
    b.add_input_address(addr)
    b.add_output(TransactionOutput(s_addr, Value(2_000_000, out_assets), datum=Unit()))
    signed = b.build_and_sign([psk], change_address=addr)
    ctx.submit_tx(signed)
    print(f"LOCK ok. amount={amt} → {s_addr}. tx={signed.id}")
    return s_addr


def unlock(mnemonic: str, policy_id: bytes, asset_name: bytes) -> None:
    ctx = context()
    psk, _, addr = wallet_from(mnemonic)
    script = build_spend(addr.payment_part.payload, policy_id, asset_name)
    s_addr = script_address(script)

    target = None
    for _ in range(60):
        for u in ctx.utxos(str(s_addr)):
            mas = u.output.amount.multi_asset
            if policy_id in mas.data and AssetName(asset_name) in mas.data[policy_id]:
                target = u
                break
        if target:
            break
        time.sleep(1)
    if not target:
        raise RuntimeError("No script UTxO with the asset")
    amt = target.output.amount.multi_asset.data[policy_id][AssetName(asset_name)]

    out_assets = MultiAsset.from_primitive({policy_id: {asset_name: amt}})
    b = TransactionBuilder(ctx)
    b.add_script_input(target, script=script, redeemer=Redeemer(Unit()))
    b.add_input_address(addr)
    b.required_signers = [addr.payment_part]
    b.add_output(TransactionOutput(addr, Value(2_000_000, out_assets)))
    signed = b.build_and_sign([psk], change_address=addr)
    ctx.submit_tx(signed)
    print(f"UNLOCK ok. tx={signed.id}")


def run_scenario() -> None:
    print("=== token-transfer scenario: mint → lock → unlock ===")
    mnemonic = fresh_mnemonic()
    _, _, addr = wallet_from(mnemonic)
    fund_from_account0(addr, 30_000_000)

    policy_id, asset_name = mint(mnemonic)
    time.sleep(2)
    lock(mnemonic, policy_id, asset_name)
    time.sleep(2)
    unlock(mnemonic, policy_id, asset_name)
    print("=== Scenario complete ===")


if __name__ == "__main__":
    run_scenario()
```

- [ ] **Step 3: Create `README.md`**

```markdown
# Token Transfer (PyCardano)

The Aiken validator is parameterised by `(receiver, policy, assetName)`.
When the target token sits in a UTxO at the script address, only the
receiver may unlock it and no foreign tokens may leave the script.

The minting side reuses a trivial always-true PlutusV3 policy so we
isolate the spend-validator's behaviour in this test.

## Prerequisites

- Python 3.11+
- Aiken (to build `plutus.json`)
- Yaci DevKit running on port `8080`

## Run

```bash
(cd ../../onchain/aiken && aiken build)
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python token_transfer.py
```

The script generates a fresh wallet (the validator inspects all outputs
and would reject stale tokens leftover from prior runs), funds it,
mints 10 `TestAsset`s, locks them, and unlocks them back to the wallet.
```

- [ ] **Step 4: Local smoke test**

```bash
cd token-transfer/offchain/pycardano
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python token_transfer.py
```

Expected: `=== Scenario complete ===` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add token-transfer/offchain/pycardano/
git commit -m "feat(pycardano): token-transfer implementation"
```

---

## Task 13: Local end-to-end verification

**Files:** none modified — verification only.

- [ ] **Step 1: Discovery picks up all four examples**

Run: `bash scripts/local-test-discovery.sh`
Expected: under `Scanning for PyCardano examples...`, four lines:
```
  - htlc
  - simple-transfer
  - token-transfer
  - vesting
```
and `PyCardano examples:        4` in the summary.

- [ ] **Step 2: Version check shows pycardano**

Run: `bash scripts/check-library-versions.sh`
Expected: a line `pycardano: 0.19.2 (up to date)` (or with a `→ <newer>` annotation if PyPI rolled forward). `jq '.libraries.pycardano' .local-test-results/version-report.json` returns a populated object.

- [ ] **Step 3: Sync-versions is a no-op**

Run: `bash scripts/sync-versions.sh --check`
Expected: exit code 0 and final line `All files are consistent with versions.json.`

- [ ] **Step 4: Dashboard JSON has the pycardano column**

Run: `bash scripts/generate-dashboard.sh`
Expected:
- `jq '.frameworks | map(.id)' docs/dashboard.json` includes `"pycardano"`.
- `jq '.useCases[] | select(.name == "simple-transfer").pycardano' docs/dashboard.json` returns `"passed"` (or `"not-implemented"` if you haven't run the local tests yet — that's also fine; the column exists either way).

- [ ] **Step 5: Commit the dashboard refresh (optional)**

If you ran the full local test suite and want to capture the refreshed dashboard:

```bash
git add docs/dashboard.json
git commit -m "chore: refresh dashboard with pycardano column"
```

(CI also commits this on PR runs, so skipping locally is fine.)

- [ ] **Step 6: Push and open a PR**

```bash
git push -u origin feat/adding-pycardano
gh pr create --title "feat: add PyCardano as off-chain framework (pilot: 4 use cases)" --body "$(cat <<'EOF'
## Summary
- Adds PyCardano (Python SDK) as the fourth off-chain framework.
- Implements 4 pilot use cases: simple-transfer, vesting, htlc, token-transfer.
- Wires up the full CI/dashboard/version-pin path so adding the remaining 15 use cases in follow-up PRs is mechanical.

See `docs/superpowers/specs/2026-05-13-pycardano-integration-design.md` for the design.

## Test plan
- [ ] CI green: `compile-aiken`, `test-pycardano` matrix (4 jobs), `report-and-dashboard`.
- [ ] Dashboard PR comment lists 4 PyCardano tests.
- [ ] `pycardano` column shows `passed` for the 4 pilot use cases on docs page.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** Tasks 1–8 implement the scaffolding from spec §3 (CI integration), §5 (`versions.json`), §6 (`check-library-versions`), §7 (`sync-versions`), §8 (`local-test-offchain`). Tasks 9–12 implement the four pilot use cases from spec §"Scope (pilot)". Task 13 covers the acceptance criteria from the spec's final section.
- **Placeholders:** none. Where PyCardano's API may vary across versions (parameter-application import path in particular), the plan flags exactly what to verify and how, but always inside an executable step.
- **Type consistency:** all four scripts use the same `wallet_at`/`wallet_from`, `context()`, `script_address`, and `slot_to_ms`/`ms_to_slot` helper signatures. `PlutusV3Script` is constructed identically via `cbor2.dumps(apply_params_to_script(...))` everywhere a parameterised script is needed.
- **Known fragility:** the `apply_params_to_script` import path in PyCardano has churned between minor versions. Task 9 Step 4 (and the inline note) directs the implementing agent to verify the import once and fix it across all four scripts if the public location differs in 0.19.2.
