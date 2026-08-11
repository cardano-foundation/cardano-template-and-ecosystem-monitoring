#!/bin/bash

# Cardano Ecosystem — Fullstack example runner (local mirror of _test-fullstack.yml)
#
# A fullstack example is self-contained: its own on-chain validator and its own
# off-chain flow in one project. There is no blueprint to inject and no on-chain
# axis to vary, so this runs a plain list per framework rather than a matrix.
#
# For each example:
#   ./gradlew build   compiles the validator to Plutus and runs its unit tests
#   ./gradlew run     executes the flow against a devnet
# The example's main() exits non-zero on any failed assertion, so the exit code
# is the whole result. Status lands in .local-test-results/<prefix>-<example>-status.txt
# for generate-dashboard.sh.
#
# Examples run SEQUENTIALLY on purpose. Running several at once starves the single
# yaci-store script-evaluation endpoint and produces spurious "Error while
# evaluating script cost" failures that look like contract bugs.
#
# Scope it while iterating:
#   ONLY_EXAMPLE=htlc bash scripts/local-test-fullstack.sh
#   ONLY_FRAMEWORK=julc-java bash scripts/local-test-fullstack.sh

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

REGISTRY="$REPO_ROOT/frameworks.json"
RESULTS_DIR="$REPO_ROOT/.local-test-results"
BACKEND_URL="${CARDANO_BACKEND_URL:-http://localhost:8080/api/v1/}"

command -v jq >/dev/null || { echo -e "${RED}ERROR: jq is required.${NC}" >&2; exit 1; }
[ -f "$REGISTRY" ] || { echo -e "${RED}ERROR: $REGISTRY not found.${NC}" >&2; exit 1; }

mkdir -p "$RESULTS_DIR"

# Reachability check up front: without a devnet every example fails identically,
# which reads as 20 broken contracts rather than one missing service.
probe_devnet() {
  curl -fsS -m 5 "${BACKEND_URL%/}/blocks/latest" >/dev/null 2>&1
}

require_devnet() {
  probe_devnet && return 0
  echo -e "${RED}No devnet reachable at ${BACKEND_URL}${NC}" >&2
  echo "Start one with: yaci-devkit up --enable-yaci-store" >&2
  echo "Or point elsewhere with CARDANO_BACKEND_URL." >&2
  exit 1
}

echo -e "${BLUE}Running fullstack examples${NC}"
echo ""

TOTAL=0
PASSED=0
FAILED=0

while IFS= read -r framework; do
  fw_id=$(jq -r  '.id'           <<<"$framework")
  label=$(jq -r  '.label'        <<<"$framework")
  prefix=$(jq -r '.statusPrefix' <<<"$framework")
  subdir=$(jq -r '.subdir'       <<<"$framework")
  runtime=$(jq -r '.runtime // "gradle"' <<<"$framework")
  # `build` frameworks have no runnable entrypoint, so compile + unit tests are
  # the whole result; `build+run` additionally executes against a devnet.
  verify=$(jq -r '.verify // "build+run"'  <<<"$framework")

  [[ -n "${ONLY_FRAMEWORK:-}" && "$fw_id" != "${ONLY_FRAMEWORK}" ]] && continue

  list="$RESULTS_DIR/${prefix}-examples.txt"
  if [ ! -f "$list" ]; then
    echo -e "${YELLOW}No discovery output for ${label}; run scripts/local-test-discovery.sh first.${NC}"
    continue
  fi

  echo -e "${BLUE}── ${label} ── (${verify})${NC}"
  [ "$verify" = "build+run" ] && require_devnet

  while IFS= read -r example; do
    [ -n "$example" ] || continue
    [[ -n "${ONLY_EXAMPLE:-}" && "$example" != "${ONLY_EXAMPLE}" ]] && continue

    dir="$REPO_ROOT/$example/$subdir"
    [ -d "$dir" ] || continue

    TOTAL=$((TOTAL + 1))
    log="$RESULTS_DIR/${prefix}-${example}.log"
    status_file="$RESULTS_DIR/${prefix}-${example}-status.txt"

    printf '  %-26s ' "$example"

    # Build (compile + unit tests) must pass before any on-chain run is meaningful.
    case "$runtime" in
      gradle) build_cmd=(./gradlew build --no-daemon --console=plain) ;;
      sbt)    build_cmd=(sbt -batch test) ;;
      *) echo -e "${RED}unknown runtime: $runtime${NC}"; echo failed > "$status_file"
         FAILED=$((FAILED + 1)); continue ;;
    esac

    if ! (cd "$dir" && "${build_cmd[@]}") > "$log" 2>&1; then
      echo -e "${RED}build failed${NC}  ($log)"
      echo failed > "$status_file"
      FAILED=$((FAILED + 1))
      continue
    fi

    if [ "$verify" != "build+run" ]; then
      echo -e "${GREEN}passed${NC} (build only)"
      echo success > "$status_file"
      PASSED=$((PASSED + 1))
      continue
    fi

    if (cd "$dir" && CARDANO_BACKEND_URL="$BACKEND_URL" \
          ./gradlew run --no-daemon --console=plain) >> "$log" 2>&1; then
      echo -e "${GREEN}passed${NC}"
      echo success > "$status_file"
      PASSED=$((PASSED + 1))
    else
      echo -e "${RED}run failed${NC}    ($log)"
      echo failed > "$status_file"
      FAILED=$((FAILED + 1))
    fi
  done < "$list"

  echo ""
done < <(jq -c '.frameworks[] | select(.kind == "fullstack")' "$REGISTRY")

echo "========================================"
echo -e "  total:  ${TOTAL}"
echo -e "  passed: ${GREEN}${PASSED}${NC}"
echo -e "  failed: ${RED}${FAILED}${NC}"
echo "========================================"

[ "$FAILED" -eq 0 ]
