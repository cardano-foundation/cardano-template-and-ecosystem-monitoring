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

# result.json schema validation. Invalid cells are surfaced in the matrix as
# `fail` cells with `error_summary: "schema violation: …"` rather than dropped
# or weakly defaulted. This catches example bugs in the runner contract instead
# of hiding them.
ALLOWED_TIERS  = {"primitive", "use-case-scenario", "use-case-example"}
ALLOWED_STATUS = {"pass", "fail", "skipped"}

# Common required fields across all tiers
COMMON_REQUIRED = ("status", "framework", "duration_ms")

# Tier-specific required identity fields
TIER_REQUIRED = {
    "use-case-example":  ("use_case",),
    "use-case-scenario": ("use_case", "id"),
    "primitive":         ("id",),
}

results_dir = os.environ["RESULTS_DIR"]
era_default = os.environ["ERA"]

violations = []

def coerce(cell, source_path):
    """Validate and lightly coerce a cell. Returns (cell, violation_or_none)."""
    # Tier (required, with fallback for very old result.json files)
    tier = cell.get("tier")
    if tier is None:
        cell["tier"] = "use-case-example"
        tier = "use-case-example"
    elif tier not in ALLOWED_TIERS:
        return cell, f"invalid tier {tier!r}"

    # Status (required, validated)
    status = cell.get("status")
    if status not in ALLOWED_STATUS:
        return cell, f"invalid or missing status {status!r}"

    # duration_ms (required, integer-coercible)
    if "duration_ms" not in cell:
        return cell, "missing required field 'duration_ms'"
    try:
        cell["duration_ms"] = int(cell["duration_ms"])
    except (TypeError, ValueError):
        return cell, f"non-integer duration_ms {cell.get('duration_ms')!r}"

    # framework (common to all tiers)
    if not cell.get("framework"):
        return cell, "missing required field 'framework'"

    # Tier-specific identity fields
    for field in TIER_REQUIRED.get(tier, ()):
        if not cell.get(field):
            return cell, f"missing required field {field!r} for tier {tier!r}"

    # Era — set to the default (versions.yml protocol_version) if absent.
    cell.setdefault("era", era_default)

    # Auto-derive id where it can be unambiguous.
    if not cell.get("id"):
        if cell.get("use_case") and cell.get("framework"):
            cell["id"] = f"{cell['use_case']}/{cell['framework']}"

    return cell, None

cells = []
for path in sorted(glob.glob(os.path.join(results_dir, "**", "*.result.json"), recursive=True)):
    try:
        with open(path) as fh:
            cell = json.load(fh)
    except Exception as exc:
        violations.append({"path": path, "reason": f"unparseable JSON: {exc}"})
        continue
    if not isinstance(cell, dict):
        violations.append({"path": path, "reason": "result.json must be a JSON object"})
        continue
    cell, violation = coerce(cell, path)
    if violation:
        # Surface the violation in the matrix as a fail cell with reason — do
        # not silently drop. This catches example bugs in the runner contract.
        violations.append({"path": path, "reason": violation})
        cell.setdefault("framework", "unknown")
        cell.setdefault("use_case", os.path.basename(path).split("__")[0] if "__" in os.path.basename(path) else "unknown")
        cell.setdefault("id", f"{cell['use_case']}/{cell['framework']}")
        cell["tier"] = cell.get("tier") if cell.get("tier") in ALLOWED_TIERS else "use-case-example"
        cell["status"] = "fail"
        cell["era"] = cell.get("era") or era_default
        cell["duration_ms"] = 0
        cell["error_summary"] = f"schema violation: {violation}"
    cells.append(cell)

summary = {"total": len(cells), "pass": 0, "fail": 0, "skipped": 0}
for cell in cells:
    s = cell.get("status", "fail")
    summary[s if s in summary else "fail"] += 1

matrix = {
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "era": era_default,
    "summary": summary,
    "cells": cells,
}
if violations:
    matrix["violations"] = violations
    sys.stderr.write(f"warning: {len(violations)} schema violation(s) in result.json files; surfaced as fail cells\n")

print(json.dumps(matrix, indent=2))
PY

echo "Aggregated $(python3 -c "import json; print(len(json.load(open('$OUTPUT_FILE'))['cells']))") result(s) → $OUTPUT_FILE" >&2
