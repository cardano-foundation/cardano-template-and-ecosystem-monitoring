#!/bin/bash
set -e

# Cardano Ecosystem – Dashboard JSON Generator
# Aggregates test results and version data into docs/dashboard.json
# consumed by the GitHub Pages dashboard.

# ── Colors ─────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ── Paths ───────────────────────────────────────────────────────────────────────
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSIONS_FILE="$REPO_ROOT/versions.json"
RESULTS_DIR="$REPO_ROOT/.local-test-results"
VERSION_REPORT="$RESULTS_DIR/version-report.json"
OUTPUT_DIR="$REPO_ROOT/docs"
OUTPUT_FILE="$OUTPUT_DIR/dashboard.json"

# ── Prerequisites ───────────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo -e "${RED}ERROR: jq is required but not installed.${NC}" >&2
  exit 0
fi

if [ ! -f "$VERSIONS_FILE" ]; then
  echo -e "${RED}ERROR: $VERSIONS_FILE not found.${NC}" >&2
  exit 0
fi

echo -e "${BLUE}Generating dashboard JSON...${NC}"
echo ""

mkdir -p "$OUTPUT_DIR"

# ── Discover all use-case names ─────────────────────────────────────────────────
# Collect unique example names from all *-status.txt files across all frameworks.
echo -e "${BLUE}Scanning test results in $RESULTS_DIR...${NC}"

ALL_EXAMPLES=""
if [ -d "$RESULTS_DIR" ]; then
  ALL_EXAMPLES=$(find "$RESULTS_DIR" -maxdepth 1 -name "*-status.txt" -type f 2>/dev/null \
    | while IFS= read -r f; do
        base=$(basename "$f")
        # Strip known prefixes and the trailing -status.txt
        name="${base#aiken-}"
        name="${name#ccl-}"
        name="${name#mesh-}"
        name="${name#lucid-}"
        name="${name%-status.txt}"
        printf '%s\n' "$name"
      done \
    | sort -u)
fi

EXAMPLE_COUNT=$(printf '%s\n' "$ALL_EXAMPLES" | grep -c . 2>/dev/null || true)
if [ -z "$ALL_EXAMPLES" ]; then
  EXAMPLE_COUNT=0
fi

echo -e "  Found ${EXAMPLE_COUNT} unique use case(s)"
echo ""

# ── Status mapping helper ────────────────────────────────────────────────────────
# map_status <raw-status-from-file>  →  prints JSON value string (no quotes)
map_status() {
  local raw="$1"
  case "$raw" in
    success) printf 'passed'  ;;
    failed)  printf 'failed'  ;;
    timeout) printf 'failed'  ;;
    skipped) printf 'skipped' ;;
    *)       printf 'failed'  ;;
  esac
}

# ── Count totals ─────────────────────────────────────────────────────────────────
TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0

if [ -d "$RESULTS_DIR" ]; then
  for status_file in "$RESULTS_DIR"/*-status.txt; do
    [ -f "$status_file" ] || continue
    raw=$(tr -d '[:space:]' < "$status_file")
    TOTAL=$((TOTAL + 1))
    case "$raw" in
      success)         PASSED=$((PASSED + 1))  ;;
      failed|timeout)  FAILED=$((FAILED + 1))  ;;
      skipped)         SKIPPED=$((SKIPPED + 1)) ;;
      *)               FAILED=$((FAILED + 1))  ;;
    esac
  done
fi

if [ "$TOTAL" -gt 0 ]; then
  SUCCESS_RATE=$(awk "BEGIN {printf \"%.2f\", $PASSED / $TOTAL}")
else
  SUCCESS_RATE="0"
fi

echo -e "  Test summary: ${TOTAL} total, ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${SKIPPED} skipped${NC}"
echo -e "  Success rate: ${SUCCESS_RATE}"
echo ""

# ── Build useCases JSON array ────────────────────────────────────────────────────
echo -e "${BLUE}Building use-cases matrix...${NC}"

USE_CASES_JSON="[]"

if [ -n "$ALL_EXAMPLES" ]; then
  while IFS= read -r example; do
    [ -n "$example" ] || continue

    # Determine per-framework status
    get_status() {
      local prefix="$1"
      local sf="$RESULTS_DIR/${prefix}-${example}-status.txt"
      if [ -f "$sf" ]; then
        local raw
        raw=$(tr -d '[:space:]' < "$sf")
        map_status "$raw"
      else
        printf 'not-implemented'
      fi
    }

    aiken_status=$(get_status "aiken")
    ccl_status=$(get_status "ccl")
    mesh_status=$(get_status "mesh")
    lucid_status=$(get_status "lucid")

    echo -e "  ${example}: aiken=${aiken_status} ccl=${ccl_status} mesh=${mesh_status} lucid=${lucid_status}"

    # Append JSON object to array using jq
    USE_CASES_JSON=$(printf '%s' "$USE_CASES_JSON" \
      | jq \
          --arg name "$example" \
          --arg aiken "$aiken_status" \
          --arg cclJava "$ccl_status" \
          --arg meshjs "$mesh_status" \
          --arg lucidEvolution "$lucid_status" \
          '. + [{name: $name, aiken: $aiken, cclJava: $cclJava, meshjs: $meshjs, lucidEvolution: $lucidEvolution}]')
  done <<< "$ALL_EXAMPLES"
fi

echo ""

# ── Build versions section ───────────────────────────────────────────────────────
echo -e "${BLUE}Building versions section...${NC}"

# current: all keys from versions.json
CURRENT_JSON=$(jq '.' "$VERSIONS_FILE")

if [ -f "$VERSION_REPORT" ]; then
  echo -e "  Using version-report.json"

  # latest: substitute .latest values from version-report.json libraries
  # Start from current, override each key that appears in the report
  LATEST_JSON=$(jq -n \
    --argjson current "$CURRENT_JSON" \
    --argjson report "$(jq '.libraries' "$VERSION_REPORT")" \
    '
      $current | to_entries | map(
        .key as $k |
        if ($report | has($k)) then
          .value = $report[$k].latest
        else
          .
        end
      ) | from_entries
    ')

  # outdated: array of library names where outdated=true
  OUTDATED_JSON=$(jq -r \
    '[.libraries | to_entries[] | select(.value.outdated == true) | .key]' \
    "$VERSION_REPORT")
else
  echo -e "  ${YELLOW}version-report.json not found – latest will equal current${NC}"
  LATEST_JSON="$CURRENT_JSON"
  OUTDATED_JSON="[]"
fi

echo ""

# ── Assemble final dashboard.json ────────────────────────────────────────────────
echo -e "${BLUE}Writing $OUTPUT_FILE...${NC}"

LAST_UPDATED=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

jq -n \
  --arg      lastUpdated      "$LAST_UPDATED" \
  --argjson  total            "$TOTAL" \
  --argjson  passed           "$PASSED" \
  --argjson  failed           "$FAILED" \
  --argjson  skipped          "$SKIPPED" \
  --argjson  successRate      "$SUCCESS_RATE" \
  --argjson  useCases         "$USE_CASES_JSON" \
  --argjson  currentVersions  "$CURRENT_JSON" \
  --argjson  latestVersions   "$LATEST_JSON" \
  --argjson  outdated         "$OUTDATED_JSON" \
  '{
    lastUpdated: $lastUpdated,
    testSummary: {
      total:       $total,
      passed:      $passed,
      failed:      $failed,
      skipped:     $skipped,
      successRate: $successRate
    },
    useCases: $useCases,
    versions: {
      current: $currentVersions,
      latest:  $latestVersions,
      outdated: $outdated
    }
  }' > "$OUTPUT_FILE"

echo -e "${GREEN}Dashboard JSON written to: $OUTPUT_FILE${NC}"
echo ""

# ── Final summary ────────────────────────────────────────────────────────────────
echo "========================================"
echo -e "  ${BLUE}lastUpdated${NC}:   $LAST_UPDATED"
echo -e "  ${BLUE}useCases${NC}:      $EXAMPLE_COUNT"
echo -e "  ${BLUE}total tests${NC}:   $TOTAL"
echo -e "  ${BLUE}passed${NC}:        ${GREEN}${PASSED}${NC}"
echo -e "  ${BLUE}failed${NC}:        ${RED}${FAILED}${NC}"
echo -e "  ${BLUE}skipped${NC}:       ${YELLOW}${SKIPPED}${NC}"
echo -e "  ${BLUE}successRate${NC}:   $SUCCESS_RATE"
OUTDATED_COUNT=$(printf '%s' "$OUTDATED_JSON" | jq 'length')
echo -e "  ${BLUE}outdated libs${NC}: $OUTDATED_COUNT"
echo "========================================"
echo ""

exit 0
