#!/usr/bin/env bash
#
# Aggregate per-cell result.json files into a single matrix.json.
#
# Usage:
#   scripts/aggregate-results.sh <results-dir> <output-file>
#
# Reads every *.result.json under <results-dir> (recursively), merges them into
# a structured matrix, and writes <output-file>.
#
# Schema of matrix.json:
#   {
#     "generated_at": "<ISO-8601 UTC>",
#     "era": "<protocol_version from versions.yml, or 'unknown'>",
#     "summary": { total, pass, fail, skipped },
#     "cells": [
#       {
#         "tier": "use-case-example" | "primitive" | "use-case-scenario",
#         "id": "<id>",
#         "use_case": "<use_case>",
#         "framework": "<framework>",
#         "era": "<era>",
#         "status": "pass" | "fail" | "skipped",
#         "duration_ms": <int>,
#         "error_summary": "<optional>"
#       },
#       ...
#     ]
#   }

set -euo pipefail

if [[ $# -lt 2 ]]; then
  cat >&2 <<EOF
usage: $0 <results-dir> <output-file>

Reads every *.result.json under <results-dir> recursively and writes a merged
matrix.json to <output-file>.
EOF
  exit 64
fi

RESULTS_DIR="$1"
OUTPUT_FILE="$2"

if [[ ! -d "$RESULTS_DIR" ]]; then
  echo "::error::results directory not found: $RESULTS_DIR" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

# Try to read protocol_version from versions.yml; fall back to 'unknown'.
ERA="unknown"
if [[ -f versions.yml ]]; then
  ERA_FROM_FILE=$(awk -F': ' '/^protocol_version[[:space:]]*:/ {
    val = $2
    sub(/^[[:space:]]+/, "", val)
    sub(/[[:space:]]+#.*$/, "", val)
    sub(/^"/, "", val)
    sub(/"$/, "", val)
    print val
    exit
  }' versions.yml)
  [[ -n "$ERA_FROM_FILE" ]] && ERA="$ERA_FROM_FILE"
fi

RESULTS_DIR="$RESULTS_DIR" ERA="$ERA" python3 - <<'PY' > "$OUTPUT_FILE"
import datetime, json, os, sys, glob

results_dir = os.environ["RESULTS_DIR"]
era_default = os.environ["ERA"]

cells = []
for path in sorted(glob.glob(os.path.join(results_dir, "**", "*.result.json"), recursive=True)):
    try:
        with open(path) as fh:
            cell = json.load(fh)
    except Exception as exc:
        sys.stderr.write(f"warning: skipping unparseable result file {path}: {exc}\n")
        continue
    # Required fields with sensible defaults
    cell.setdefault("tier", "use-case-example")
    cell.setdefault("status", "fail")
    cell.setdefault("era", era_default)
    cell.setdefault("duration_ms", 0)
    cells.append(cell)

summary = {"total": len(cells), "pass": 0, "fail": 0, "skipped": 0}
for cell in cells:
    s = cell.get("status", "fail")
    if s in summary:
        summary[s] += 1
    else:
        summary["fail"] += 1

matrix = {
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "era": era_default,
    "summary": summary,
    "cells": cells,
}
print(json.dumps(matrix, indent=2))
PY

echo "Aggregated $(python3 -c "import json; print(len(json.load(open('$OUTPUT_FILE'))['cells']))") result(s) → $OUTPUT_FILE" >&2
