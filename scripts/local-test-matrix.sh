#!/usr/bin/env bash
#
# Run the full ecosystem test matrix locally and produce a matrix.json plus a
# rendered markdown report. Uses the same primitives the CI workflow uses
# (scripts/local-test-discovery.sh, scripts/ci/run-cell.sh,
# scripts/aggregate-results.sh, scripts/render-matrix.sh) so a contributor's
# local report has the same shape as CI's GitHub Actions step summary.
#
# Prerequisites:
#   - Yaci DevKit running (yaci-devkit up --enable-yaci-store)
#   - The toolchains pinned in versions.yml installed locally (Aiken, Deno,
#     JBang + JDK). docs/how-to/run-locally.md walks through this.
#
# Usage:
#   scripts/local-test-matrix.sh [--only=<framework>[,<framework>...]] [--use-cases=<uc>[,<uc>...]]
#
# Examples:
#   scripts/local-test-matrix.sh                           # everything
#   scripts/local-test-matrix.sh --only=aiken              # just aiken compile cells
#   scripts/local-test-matrix.sh --use-cases=escrow,vesting  # just two use cases
#
# Output:
#   .ci-results/<use_case>__<framework>.result.json   per cell
#   .ci-results/<use_case>__<framework>.log           per cell
#   matrix.json                                       aggregated
#   matrix-report.md                                  rendered

set -uo pipefail

ONLY=""
USE_CASES=""
for arg in "$@"; do
  case "$arg" in
    --only=*)      ONLY="${arg#--only=}" ;;
    --use-cases=*) USE_CASES="${arg#--use-cases=}" ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      exit 64
      ;;
  esac
done

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

# 0. Load versions (sets PATH and version env vars used by run-cell.sh)
if [[ -f versions.yml ]]; then
  PROTOCOL_VERSION_VERSION=$(awk -F': ' '/^protocol_version[[:space:]]*:/ {gsub(/[ "]/, "", $2); print $2; exit}' versions.yml)
  export PROTOCOL_VERSION_VERSION
fi

# 1. Discover (writes .local-test-results/)
chmod +x scripts/local-test-discovery.sh
scripts/local-test-discovery.sh

# 2. Resolve which cells to run.
mkdir -p .ci-results
chmod +x scripts/ci/run-cell.sh

cells_to_run() {
  # Emit one "use_case framework" pair per line.
  for fw_file in frameworks/*.yml; do
    fw=$(basename "$fw_file" .yml)
    [[ "$fw_file" == "frameworks/SCHEMA.md" ]] && continue
    if [[ -n "$ONLY" ]] && ! grep -qE "(^|,)${fw}(,|$)" <<< "$ONLY"; then
      continue
    fi
    fw_list=".local-test-results/${fw}-examples.txt"
    [[ -f "$fw_list" ]] || continue
    while IFS= read -r uc; do
      [[ -z "$uc" ]] && continue
      if [[ -n "$USE_CASES" ]] && ! grep -qE "(^|,)${uc}(,|$)" <<< "$USE_CASES"; then
        continue
      fi
      echo "$uc $fw"
    done < "$fw_list"
  done
}

# 3. Run each cell.
TOTAL=0
FAILURES=0
while IFS=' ' read -r uc fw; do
  TOTAL=$((TOTAL + 1))
  echo
  echo "::group::${uc} / ${fw}"
  if scripts/ci/run-cell.sh "$uc" "$fw" .ci-results; then
    echo "  ✅ ${uc}/${fw}"
  else
    echo "  ❌ ${uc}/${fw}"
    FAILURES=$((FAILURES + 1))
  fi
  echo "::endgroup::"
done < <(cells_to_run)

echo
echo "Ran $TOTAL cell(s); $FAILURES failed."

# 4. Aggregate + render.
chmod +x scripts/aggregate-results.sh scripts/render-matrix.sh
scripts/aggregate-results.sh .ci-results matrix.json
scripts/render-matrix.sh matrix.json > matrix-report.md

echo
echo "📊 matrix.json     ← aggregated cell results"
echo "📊 matrix-report.md ← rendered markdown report (cat to view)"
echo

# Exit non-zero if any cell failed.
if [[ "$FAILURES" -gt 0 ]]; then
  exit 1
fi
