#!/bin/bash
set -e

# Cardano Ecosystem – Dashboard JSON Generator
# Aggregates test results and version data into docs/dashboard.json
# consumed by the GitHub Pages dashboard.
#
# Data model
# ──────────────────────────────────────────────────────────────────────────────
# Status files in .local-test-results/:
#
#   On-chain compile  →  <onchain-prefix>-<example>-status.txt
#                        e.g. aiken-bet-status.txt, scalus-auction-status.txt
#
#   Off-chain tests   →  <offchain-prefix>-<onchain-id>-<example>-status.txt
#                        e.g. ccl-aiken-bet-status.txt
#                             mesh-scalus-auction-status.txt
#
# Dashboard column IDs in useCases:
#   Onchain:      <onchain-id>              (e.g. "aiken", "scalus")
#   Cross-check:  <offchain-id>+<onchain-id> (e.g. "ccl-java+aiken")

# ── Colors ─────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ── Paths ───────────────────────────────────────────────────────────────────────
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSIONS_FILE="$REPO_ROOT/versions.json"
FRAMEWORKS_FILE="$REPO_ROOT/frameworks.json"
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
  echo -e "${RED}ERROR: $VERSIONS_FILE not found.${NC}" >&2; exit 0
fi
if [ ! -f "$FRAMEWORKS_FILE" ]; then
  echo -e "${RED}ERROR: $FRAMEWORKS_FILE not found.${NC}" >&2; exit 0
fi

echo -e "${BLUE}Generating dashboard JSON...${NC}"
echo ""

mkdir -p "$OUTPUT_DIR"

# ── Split frameworks by kind ────────────────────────────────────────────────────
ONCHAIN_FRAMEWORKS=$(jq -c  '[.frameworks[] | select(.kind == "onchain")]'  "$FRAMEWORKS_FILE")
OFFCHAIN_FRAMEWORKS=$(jq -c '[.frameworks[] | select(.kind == "offchain")]' "$FRAMEWORKS_FILE")

# Flat technology list (kind preserved) — emitted as `technologies` so the
# frontend can render a chip strip of underlying technologies separately from
# the cross-product matrix columns. New frameworks added to frameworks.json
# appear in the strip automatically.
TECHNOLOGIES_JSON=$(jq -c '[.frameworks[] | {id, label, kind}]' "$FRAMEWORKS_FILE")

# All status-file prefixes (for example-name extraction from file names)
ALL_ONCHAIN_PREFIXES=$(jq -r '.[] | .statusPrefix' <<<"$ONCHAIN_FRAMEWORKS")
ALL_OFFCHAIN_PREFIXES=$(jq -r '.[] | .statusPrefix' <<<"$OFFCHAIN_FRAMEWORKS")

# ── Discover all use-case names ─────────────────────────────────────────────────
echo -e "${BLUE}Scanning test results in $RESULTS_DIR...${NC}"

ALL_EXAMPLES=""
if [ -d "$RESULTS_DIR" ]; then
  ALL_EXAMPLES=$(find "$RESULTS_DIR" -maxdepth 1 -name "*-status.txt" -type f 2>/dev/null \
    | while IFS= read -r f; do
        base=$(basename "$f")
        name="${base%-status.txt}"
        # Strip onchain prefix  (e.g. "aiken-bet" → "bet")
        for prefix in $ALL_ONCHAIN_PREFIXES; do
          if [[ "$name" == "${prefix}-"* ]]; then
            name="${name#${prefix}-}"
            printf '%s\n' "$name"
            break
          fi
        done
        # Strip offchain-onchain prefix  (e.g. "ccl-aiken-bet" → "bet")
        for opfx in $ALL_ONCHAIN_PREFIXES; do
          for pfx in $ALL_OFFCHAIN_PREFIXES; do
            if [[ "$name" == "${pfx}-${opfx}-"* ]]; then
              name="${name#${pfx}-${opfx}-}"
              printf '%s\n' "$name"
              break 2
            fi
          done
        done
      done \
    | sort -u)
fi

EXAMPLE_COUNT=$(printf '%s\n' "$ALL_EXAMPLES" | grep -c . 2>/dev/null || true)
[ -z "$ALL_EXAMPLES" ] && EXAMPLE_COUNT=0

echo -e "  Found ${EXAMPLE_COUNT} unique use case(s)"
echo ""

# ── Status mapping helper ────────────────────────────────────────────────────────
map_status() {
  case "$1" in
    success) printf 'passed'  ;;
    failed)  printf 'failed'  ;;
    timeout) printf 'failed'  ;;
    skipped) printf 'skipped' ;;
    *)       printf 'failed'  ;;
  esac
}

# ── Count totals ─────────────────────────────────────────────────────────────────
TOTAL=0; PASSED=0; FAILED=0; SKIPPED=0
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
[ "$TOTAL" -gt 0 ] && SUCCESS_RATE=$(awk "BEGIN {printf \"%.2f\", $PASSED / $TOTAL}") || SUCCESS_RATE="0"

echo -e "  Test summary: ${TOTAL} total, ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${YELLOW}${SKIPPED} skipped${NC}"
echo -e "  Success rate: ${SUCCESS_RATE}"
echo ""

# ── Build dashboard column list ─────────────────────────────────────────────────
# Columns = one per onchain framework + one per (offchain × onchain) pair.
echo -e "${BLUE}Building column list...${NC}"

COLUMNS_JSON="[]"

# 1. Onchain compile columns
while IFS= read -r fw; do
  id=$(jq -r '.id'    <<<"$fw")
  lbl=$(jq -r '.label' <<<"$fw")
  COLUMNS_JSON=$(jq -n \
    --argjson cols "$COLUMNS_JSON" \
    --arg id "$id" --arg label "$lbl" \
    '$cols + [{id: $id, label: $label, kind: "onchain"}]')
done < <(jq -c '.[]' <<<"$ONCHAIN_FRAMEWORKS")

# 2. Cross-product columns (offchain × onchain), ordered offchain-first then onchain
while IFS= read -r ofw; do
  off_id=$(jq -r  '.id'          <<<"$ofw")
  off_lbl=$(jq -r '.label'       <<<"$ofw")
  while IFS= read -r nfw; do
    on_id=$(jq -r  '.id'    <<<"$nfw")
    on_lbl=$(jq -r '.label' <<<"$nfw")
    col_id="${off_id}+${on_id}"
    col_lbl="${off_lbl} × ${on_lbl}"
    COLUMNS_JSON=$(jq -n \
      --argjson cols "$COLUMNS_JSON" \
      --arg id "$col_id" --arg label "$col_lbl" \
      '$cols + [{id: $id, label: $label, kind: "cross"}]')
  done < <(jq -c '.[]' <<<"$ONCHAIN_FRAMEWORKS")
done < <(jq -c '.[]' <<<"$OFFCHAIN_FRAMEWORKS")

echo -e "  ${#COLUMNS_JSON} column(s) built"
echo ""

# ── Build useCases JSON array ────────────────────────────────────────────────────
echo -e "${BLUE}Building use-cases matrix...${NC}"

USE_CASES_JSON="[]"

if [ -n "$ALL_EXAMPLES" ]; then
  while IFS= read -r example; do
    [ -n "$example" ] || continue

    statuses_json='{}'
    log_line="  ${example}:"

    # Onchain compile status: look for <onchain-prefix>-<example>-status.txt
    while IFS= read -r fw; do
      on_id=$(jq -r     '.id'          <<<"$fw")
      on_pfx=$(jq -r    '.statusPrefix' <<<"$fw")
      sf="$RESULTS_DIR/${on_pfx}-${example}-status.txt"
      if [ -f "$sf" ]; then
        status=$(map_status "$(tr -d '[:space:]' < "$sf")")
      else
        status='not-implemented'
      fi
      log_line="${log_line} ${on_id}=${status}"
      statuses_json=$(jq -n \
        --argjson s "$statuses_json" --arg k "$on_id" --arg v "$status" \
        '$s + {($k): $v}')
    done < <(jq -c '.[]' <<<"$ONCHAIN_FRAMEWORKS")

    # Cross-product status: look for <offchain-prefix>-<onchain-id>-<example>-status.txt
    while IFS= read -r ofw; do
      off_id=$(jq -r  '.id'          <<<"$ofw")
      off_pfx=$(jq -r '.statusPrefix' <<<"$ofw")
      while IFS= read -r nfw; do
        on_id=$(jq -r '.id' <<<"$nfw")
        col_id="${off_id}+${on_id}"
        sf="$RESULTS_DIR/${off_pfx}-${on_id}-${example}-status.txt"
        if [ -f "$sf" ]; then
          status=$(map_status "$(tr -d '[:space:]' < "$sf")")
        else
          status='not-implemented'
        fi
        log_line="${log_line} ${col_id}=${status}"
        statuses_json=$(jq -n \
          --argjson s "$statuses_json" --arg k "$col_id" --arg v "$status" \
          '$s + {($k): $v}')
      done < <(jq -c '.[]' <<<"$ONCHAIN_FRAMEWORKS")
    done < <(jq -c '.[]' <<<"$OFFCHAIN_FRAMEWORKS")

    echo -e "$log_line"

    USE_CASES_JSON=$(jq -n \
      --argjson uc "$USE_CASES_JSON" \
      --arg name "$example" \
      --argjson statuses "$statuses_json" \
      '$uc + [({name: $name} + $statuses)]')
  done <<< "$ALL_EXAMPLES"
fi

echo ""

# ── Build versions section ───────────────────────────────────────────────────────
echo -e "${BLUE}Building versions section...${NC}"

CURRENT_JSON=$(jq '.' "$VERSIONS_FILE")

if [ -f "$VERSION_REPORT" ]; then
  echo -e "  Using version-report.json"
  LATEST_JSON=$(jq -n \
    --argjson current "$CURRENT_JSON" \
    --argjson report "$(jq '.libraries' "$VERSION_REPORT")" \
    '$current | to_entries | map(
      .key as $k |
      if ($report | has($k)) then .value = $report[$k].latest else . end
    ) | from_entries')
  OUTDATED_JSON=$(jq -r '[.libraries | to_entries[] | select(.value.outdated == true) | .key]' "$VERSION_REPORT")
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
  --arg      lastUpdated     "$LAST_UPDATED" \
  --argjson  total           "$TOTAL" \
  --argjson  passed          "$PASSED" \
  --argjson  failed          "$FAILED" \
  --argjson  skipped         "$SKIPPED" \
  --argjson  successRate     "$SUCCESS_RATE" \
  --argjson  frameworks      "$COLUMNS_JSON" \
  --argjson  technologies    "$TECHNOLOGIES_JSON" \
  --argjson  useCases        "$USE_CASES_JSON" \
  --argjson  currentVersions "$CURRENT_JSON" \
  --argjson  latestVersions  "$LATEST_JSON" \
  --argjson  outdated        "$OUTDATED_JSON" \
  '{
    lastUpdated: $lastUpdated,
    testSummary: {
      total:       $total,
      passed:      $passed,
      failed:      $failed,
      skipped:     $skipped,
      successRate: $successRate
    },
    frameworks:   $frameworks,
    technologies: $technologies,
    useCases:     $useCases,
    versions: {
      current:  $currentVersions,
      latest:   $latestVersions,
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
OUTDATED_COUNT=$(jq 'length' <<<"$OUTDATED_JSON")
echo -e "  ${BLUE}outdated libs${NC}: $OUTDATED_COUNT"
echo "========================================"
echo ""

exit 0