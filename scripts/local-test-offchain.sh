#!/bin/bash

# Cardano Ecosystem Off-chain Integration Test Script
# Runs every off-chain example against Yaci DevKit — once per on-chain
# implementation that exists for the example (e.g. aiken AND scalus), so the
# dashboard's cross-check matrix (<off> × <on>) is populated from real runs.
#
# Status files written (consumed by generate-dashboard.sh):
#   On-chain compile : <onchain-prefix>-<example>-status.txt        e.g. scalus-auction-status.txt
#   Cross-check      : <off-prefix>-<onchain-id>-<example>-status.txt e.g. mesh-scalus-auction-status.txt
#
# How an off-chain example is pointed at a given on-chain blueprint:
#   The off-chain code reads the PLUTUS_JSON env var (falling back to its local
#   Aiken blueprint). For any NON-aiken on-chain we only run the combo if the
#   off-chain source actually references PLUTUS_JSON — otherwise it would silently
#   re-test Aiken and report a false positive. See offchain_uses_env().

trap 'echo -e "\n\n${RED}❌ Tests interrupted by user${NC}"; exit 130' INT TERM

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}🧪 Running Off-chain Integration Tests${NC}"
echo "========================================"
echo ""

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

RESULTS_DIR=".local-test-results"
mkdir -p "$RESULTS_DIR"

FRAMEWORKS_FILE="$REPO_ROOT/frameworks.json"

# ── Yaci DevKit availability ──────────────────────────────────────────────────
echo -n "Checking Yaci DevKit... "
if nc -z localhost 8080 2>/dev/null; then
  echo -e "${GREEN}✅ Running${NC}"
else
  echo -e "${RED}❌ Not running${NC}"
  echo ""
  echo "Please start Yaci DevKit first:"
  echo "  yaci-devkit up --enable-yaci-store"
  echo ""
  exit 1
fi
echo ""

# ── Portable timeout (macOS lacks `timeout`; use gtimeout or run unbounded) ────
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout &>/dev/null; then
    timeout --foreground "$secs" "$@"
  elif command -v gtimeout &>/dev/null; then
    gtimeout --foreground "$secs" "$@"
  else
    "$@"
  fi
}

# ── On-chain framework registry (from frameworks.json) ────────────────────────
# (read loop, not `mapfile` — keep macOS bash 3.2 compatibility)
ONCHAIN_IDS=()
if command -v jq &>/dev/null && [ -f "$FRAMEWORKS_FILE" ]; then
  while IFS= read -r _id; do
    [ -n "$_id" ] && ONCHAIN_IDS+=("$_id")
  done < <(jq -r '.frameworks[] | select(.kind=="onchain") | .id' "$FRAMEWORKS_FILE")
fi
if [ ${#ONCHAIN_IDS[@]} -eq 0 ]; then
  echo -e "${YELLOW}⚠️  jq/frameworks.json unavailable — defaulting to aiken only${NC}"
  ONCHAIN_IDS=(aiken)
fi
echo -e "${BLUE}On-chain implementations:${NC} ${ONCHAIN_IDS[*]}"
echo ""

onchain_prefix() {
  if command -v jq &>/dev/null && [ -f "$FRAMEWORKS_FILE" ]; then
    jq -r --arg id "$1" '.frameworks[] | select(.id==$id) | .statusPrefix' "$FRAMEWORKS_FILE"
  else
    printf '%s' "$1"
  fi
}

# offchain_uses_env <entry-file> → true if the source reads PLUTUS_JSON.
offchain_uses_env() { grep -q 'PLUTUS_JSON' "$1" 2>/dev/null; }

# build_onchain <example> <onid>
#   Builds the on-chain blueprint, writes its compile status file, and prints the
#   absolute plutus.json path on success (empty string on failure).
build_onchain() {
  local example="$1" onid="$2"
  local dir="$REPO_ROOT/$example/onchain/$onid"
  local pj="$dir/plutus.json"
  local pfx; pfx="$(onchain_prefix "$onid")"

  case "$onid" in
    aiken)
      if [[ ! -f "$pj" && -f "$dir/aiken.toml" ]] && command -v aiken &>/dev/null; then
        (cd "$dir" && aiken build >/dev/null 2>&1) || true
      fi
      ;;
    scalus)
      # Regenerate so the blueprint reflects the current source.
      if [[ -f "$dir/build.sbt" ]] && command -v sbt &>/dev/null; then
        (cd "$dir" && sbt -batch run >/dev/null 2>&1) || true
      fi
      ;;
    *)
      if [[ ! -f "$pj" && -f "$dir/aiken.toml" ]] && command -v aiken &>/dev/null; then
        (cd "$dir" && aiken build >/dev/null 2>&1) || true
      fi
      ;;
  esac

  if [[ -f "$pj" ]]; then
    echo "success" > "$RESULTS_DIR/${pfx}-${example}-status.txt"
    printf '%s' "$pj"
  else
    echo "failed" > "$RESULTS_DIR/${pfx}-${example}-status.txt"
    printf ''
  fi
}

# write_status <off-prefix> <onid> <example> <value>
write_status() {
  echo "$4" > "$RESULTS_DIR/${1}-${2}-${3}-status.txt"
}

# classify_exit <code> → echoes success|timeout|failed
classify_exit() {
  if [[ "$1" -eq 0 ]]; then echo success
  elif [[ "$1" -eq 124 ]]; then echo timeout
  else echo failed; fi
}

# Per-framework counters (plain globals — bash 3.2 has no associative arrays).
# run_matrix resets and fills these; print_fw_summary consumes them.
RM_TOTAL=0; RM_PASSED=0; RM_FAILED=0
GRAND_FAILED=0

# print_fw_summary <label> — prints the last run_matrix result and accumulates failures.
print_fw_summary() {
  [[ "$RM_TOTAL" -gt 0 ]] || return 0
  echo "$1:"
  echo "  Total:   $RM_TOTAL"
  echo -e "  ${GREEN}Passed:  $RM_PASSED ✅${NC}"
  echo -e "  ${RED}Failed:  $RM_FAILED ❌${NC}"
  echo ""
  GRAND_FAILED=$(( GRAND_FAILED + RM_FAILED ))
}

# run_matrix <off-id> <off-prefix> <entry-glob> <run-fn>
#   Discovers examples via <entry-glob>, then for each (example × on-chain) runs
#   <run-fn> "<entry-file>" "<plutus-json>" "<logfile>" inside the example dir.
run_matrix() {
  local off_id="$1" off_pfx="$2" glob="$3" run_fn="$4"
  RM_TOTAL=0; RM_PASSED=0; RM_FAILED=0

  while IFS= read -r marker; do
    [[ -f "$marker" ]] || continue
    local dir example
    dir=$(dirname "$marker")
    example=$(echo "$marker" | cut -d'/' -f2)

    # Resolve the entry file (language-specific) once per example.
    local entry
    entry=$("resolve_entry_${off_pfx}" "$dir") || true
    if [[ -z "$entry" ]]; then
      echo -e "   ${RED}❌ No entry file in $dir${NC}"
      continue
    fi

    for onid in "${ONCHAIN_IDS[@]}"; do
      local on_dir="$REPO_ROOT/$example/onchain/$onid"
      [[ -d "$on_dir" ]] || continue

      # Safety gate: a non-aiken combo only runs if the off-chain honors
      # PLUTUS_JSON, else it would re-test Aiken and report a false positive.
      if [[ "$onid" != "aiken" ]] && ! offchain_uses_env "$dir/$entry"; then
        echo -e "   ${YELLOW}⏭  ${example} [${off_id}×${onid}]: off-chain not PLUTUS_JSON-aware, skipping${NC}"
        write_status "$off_pfx" "$onid" "$example" "skipped"
        continue
      fi

      RM_TOTAL=$(( RM_TOTAL + 1 ))
      echo -e "${YELLOW}📦 [${RM_TOTAL}] ${example}  (${off_id} × ${onid})${NC}"

      local pj
      pj=$(build_onchain "$example" "$onid")
      if [[ -z "$pj" ]]; then
        echo -e "   ${RED}❌ ${onid} blueprint build failed${NC}"
        RM_FAILED=$(( RM_FAILED + 1 ))
        write_status "$off_pfx" "$onid" "$example" "failed"
        echo ""
        continue
      fi

      local log="$REPO_ROOT/$RESULTS_DIR/${off_pfx}-${onid}-${example}.log"
      echo "   Blueprint: ${pj#$REPO_ROOT/}"
      echo "   Running (timeout 300s, Ctrl+C to skip)..."
      echo ""

      # `|| code=$?` keeps `set -e` from aborting the whole run on a failing test.
      local code=0
      ( cd "$dir" && PLUTUS_JSON="$pj" "$run_fn" "$entry" "$log" ) || code=$?

      local status; status=$(classify_exit "$code")
      write_status "$off_pfx" "$onid" "$example" "$status"
      if [[ "$status" == "success" ]]; then
        RM_PASSED=$(( RM_PASSED + 1 ))
        echo -e "   ${GREEN}✅ PASSED${NC}"
      else
        RM_FAILED=$(( RM_FAILED + 1 ))
        if [[ "$status" == "timeout" ]]; then
          echo -e "   ${RED}❌ TIMEOUT (>300s)${NC}"
        else
          echo -e "   ${RED}❌ FAILED (exit $code)${NC}"
          tail -10 "$log" 2>/dev/null | sed 's/^/   | /'
        fi
      fi
      echo ""
    done
  done < <(find . -maxdepth 4 -path "$glob" -type f | sort)
}

# ── Entry-file resolvers (per off-chain language; portable, no `xargs -r`) ─────
_first_basename() { local f; f=$(find "$1" -maxdepth 1 -name "$2" -type f | head -1); [[ -n "$f" ]] && basename "$f"; }
resolve_entry_ccl()       { _first_basename "$1" "*.java"; }
resolve_entry_mesh()      { _first_basename "$1" "*.ts"; }
resolve_entry_evosdk()    { _first_basename "$1" "*.ts"; }
resolve_entry_pycardano() { _first_basename "$1" "*.py"; }

# ── Run-functions (executed inside the example dir; PLUTUS_JSON already set) ───
run_ccl() {
  run_with_timeout 300 jbang "$1" 2>&1 | tee "$2"
  return "${PIPESTATUS[0]}"
}
run_deno() {
  run_with_timeout 300 deno run --allow-all "$1" 2>&1 | tee "$2"
  return "${PIPESTATUS[0]}"
}
run_pycardano() {
  local entry="$1" log="$2"
  local venv=".venv-local"
  [[ -d "$venv" ]] || python3 -m venv "$venv"
  # shellcheck source=/dev/null
  source "$venv/bin/activate"
  pip install --quiet --upgrade pip >/dev/null 2>&1 || true
  pip install --quiet -r requirements.txt >/dev/null 2>&1 || true
  run_with_timeout 300 python "$entry" 2>&1 | tee "$log"
  local code="${PIPESTATUS[0]}"
  deactivate || true
  return "$code"
}

# ── CCL Java ──────────────────────────────────────────────────────────────────
echo -e "${BLUE}Testing CCL Java Examples${NC}"; echo "----------------------------------------"
if command -v jbang &>/dev/null; then
  echo "JBang: $(jbang version 2>/dev/null || echo unknown)"; echo ""
  run_matrix "ccl-java" "ccl" "*/offchain/ccl-java/*.java" run_ccl
  print_fw_summary "CCL Java"
else
  echo -e "${RED}❌ JBang not installed. Skipping CCL Java tests.${NC}"; echo ""
fi

# ── Mesh.js ───────────────────────────────────────────────────────────────────
echo ""; echo -e "${BLUE}Testing Mesh.js Examples${NC}"; echo "----------------------------------------"
if command -v deno &>/dev/null; then
  echo "Deno: $(deno --version | head -1)"; echo ""
  run_matrix "meshjs" "mesh" "*/offchain/meshjs/*.ts" run_deno
  print_fw_summary "Mesh.js"
else
  echo -e "${RED}❌ Deno not installed. Skipping Mesh.js tests.${NC}"; echo ""
fi

# ── Evolution SDK ─────────────────────────────────────────────────────────────
echo ""; echo -e "${BLUE}Testing Evolution SDK Examples${NC}"; echo "----------------------------------------"
if command -v deno &>/dev/null; then
  run_matrix "evolutionsdk" "evosdk" "*/offchain/evolutionsdk/*.ts" run_deno
  print_fw_summary "Evolution SDK"
else
  echo -e "${RED}❌ Deno not installed. Skipping Evolution SDK tests.${NC}"; echo ""
fi

# ── PyCardano ─────────────────────────────────────────────────────────────────
echo ""; echo -e "${BLUE}Testing PyCardano Examples${NC}"; echo "----------------------------------------"
if command -v python3 &>/dev/null; then
  echo "Python: $(python3 --version 2>&1)"; echo ""
  run_matrix "pycardano" "pycardano" "*/offchain/pycardano/requirements.txt" run_pycardano
  print_fw_summary "PyCardano"
else
  echo -e "${RED}❌ Python not installed. Skipping PyCardano tests.${NC}"; echo ""
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo -e "${BLUE}========================================"
echo "Off-chain Test Summary"
echo -e "========================================${NC}"

if [[ "$GRAND_FAILED" -gt 0 ]]; then
  echo -e "${RED}Some tests failed. Check logs in $RESULTS_DIR/${NC}"
  exit 1
else
  echo -e "${GREEN}All off-chain tests passed! 🎉${NC}"
  exit 0
fi
