#!/usr/bin/env bash
#
# Run one (use-case, framework) cell. Reads the framework descriptor at
# frameworks/<framework>.yml to determine cwd_relative_to_example, the run
# command, and default_entry; reads <use-case>/example.yml to find the
# explicit entry; substitutes $ENTRY into the descriptor's command; runs
# from the resolved working directory; captures stdout/stderr to a log;
# writes a result.json describing pass/fail/duration.
#
# Usage:
#   scripts/ci/run-cell.sh <use_case> <framework> [<output_dir>]
#
# Environment:
#   PROTOCOL_VERSION_VERSION   Era this run is tagged with (set by load-versions).
#
# Output files (in <output_dir>, defaults to .ci-results):
#   <use_case>__<framework>.log
#   <use_case>__<framework>.result.json
#
# This is the entry point that makes the framework registry load-bearing.
# Adding a new framework descriptor under frameworks/<name>.yml — and a
# manifest entry under <use-case>/example.yml — is sufficient: this script
# reads them at runtime, no workflow YAML edits required.

set -uo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <use_case> <framework> [<output_dir>]" >&2
  exit 64
fi

USE_CASE="$1"
FRAMEWORK="$2"
OUT_DIR="${3:-.ci-results}"
ERA="${PROTOCOL_VERSION_VERSION:-unknown}"

mkdir -p "$OUT_DIR"
LOG_FILE="${OUT_DIR}/${USE_CASE}__${FRAMEWORK}.log"
RESULT_FILE="${OUT_DIR}/${USE_CASE}__${FRAMEWORK}.result.json"

DESCRIPTOR="frameworks/${FRAMEWORK}.yml"
MANIFEST="${USE_CASE}/example.yml"

write_result_json() {
  local status="$1"
  local duration_ms="$2"
  local err_summary="${3:-}"
  USE_CASE="$USE_CASE" FRAMEWORK="$FRAMEWORK" ERA="$ERA" \
    STATUS="$status" DUR_MS="$duration_ms" ERR_SUMMARY="$err_summary" \
    python3 - > "$RESULT_FILE" <<'PY'
import json, os
out = {
    "tier": "use-case-example",
    "id": f"{os.environ['USE_CASE']}/{os.environ['FRAMEWORK']}",
    "use_case": os.environ["USE_CASE"],
    "framework": os.environ["FRAMEWORK"],
    "era": os.environ.get("ERA", "unknown"),
    "status": os.environ["STATUS"],
    "duration_ms": int(os.environ["DUR_MS"]),
}
err = os.environ.get("ERR_SUMMARY", "").strip()
if err:
    out["error_summary"] = err
print(json.dumps(out, indent=2))
PY
}

if [[ ! -f "$DESCRIPTOR" ]]; then
  echo "::error::framework descriptor not found: $DESCRIPTOR"
  write_result_json fail 0 "framework descriptor not found at ${DESCRIPTOR}"
  exit 1
fi

# Extract a dotted-path field from a flat-or-shallow YAML file. Supports
# top-level keys and one level of nesting (e.g. "run.command", "result.convention").
# Pure-Python regex parser — no PyYAML dependency.
yaml_get() {
  local file="$1"
  local path="$2"
  YAML_FILE="$file" YAML_PATH="$path" python3 - <<'PY'
import os, re, sys
path = os.environ["YAML_PATH"].split(".")
target = ".".join(path)
out = None
with open(os.environ["YAML_FILE"]) as fh:
    lines = fh.readlines()
stack = []  # (indent, key)
for raw in lines:
    line = raw.rstrip("\n")
    stripped = line.lstrip()
    if not stripped or stripped.startswith("#"):
        continue
    indent = len(line) - len(stripped)
    m = re.match(r'([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$', stripped)
    if not m:
        continue
    key, val = m.group(1), m.group(2)
    if val and not val.startswith('"'):
        val = re.sub(r'\s+#.*$', '', val)
    val = val.strip()
    while stack and stack[-1][0] >= indent:
        stack.pop()
    full = ".".join([k for _, k in stack] + [key])
    if val:
        if val.startswith('"') and val.endswith('"'):
            val = val[1:-1]
        if full == target:
            out = val
            break
    else:
        stack.append((indent, key))
if out is not None:
    print(out)
PY
}

FW_KIND=$(yaml_get "$DESCRIPTOR" "kind")
FW_RUN_CWD=$(yaml_get "$DESCRIPTOR" "run.cwd_relative_to_example")
FW_RUN_CMD=$(yaml_get "$DESCRIPTOR" "run.command")
FW_DEFAULT_ENTRY=$(yaml_get "$DESCRIPTOR" "default_entry")
FW_RESULT_CONVENTION=$(yaml_get "$DESCRIPTOR" "result.convention")
FW_MANIFEST_KEY=$(yaml_get "$DESCRIPTOR" "manifest_key")
: "${FW_MANIFEST_KEY:=$FRAMEWORK}"
: "${FW_RESULT_CONVENTION:=exit-code}"

if [[ -z "${FW_KIND:-}" || -z "${FW_RUN_CWD:-}" || -z "${FW_RUN_CMD:-}" ]]; then
  echo "::error file=$DESCRIPTOR::descriptor missing required fields (kind / run.cwd_relative_to_example / run.command)"
  write_result_json fail 0 "descriptor ${DESCRIPTOR} missing required fields"
  exit 1
fi

WORKDIR="${USE_CASE}/${FW_RUN_CWD}"
if [[ ! -d "$WORKDIR" ]]; then
  echo "::error::working directory $WORKDIR does not exist (declared in $MANIFEST under ${FW_KIND}.${FW_MANIFEST_KEY}, or implied by descriptor)"
  write_result_json fail 0 "working directory ${WORKDIR} does not exist"
  exit 1
fi

# Resolve entry: prefer the manifest's explicit entry, fall back to default_entry glob.
ENTRY=""
if [[ -f "$MANIFEST" ]]; then
  ENTRY=$(yaml_get "$MANIFEST" "${FW_KIND}.${FW_MANIFEST_KEY}.entry" || true)
fi
if [[ -z "${ENTRY:-}" && -n "${FW_DEFAULT_ENTRY:-}" ]]; then
  shopt -s nullglob
  pushd "$WORKDIR" > /dev/null
  matches=( $FW_DEFAULT_ENTRY )
  popd > /dev/null
  shopt -u nullglob
  if [[ ${#matches[@]} -gt 0 ]]; then
    ENTRY="${matches[0]}"
  fi
fi

if [[ -z "${ENTRY:-}" ]]; then
  echo "::error::could not resolve an entry file for ${USE_CASE}/${FRAMEWORK} (no manifest entry, no default_entry match in ${WORKDIR})"
  write_result_json fail 0 "could not resolve entry file"
  exit 1
fi

echo "Running ${USE_CASE}/${FRAMEWORK}: cd ${WORKDIR} && ${FW_RUN_CMD} (ENTRY=${ENTRY}, descriptor=${DESCRIPTOR})"

START_NS=$(date +%s%N)
(
  cd "$WORKDIR"
  ENTRY="$ENTRY" bash -c "$FW_RUN_CMD"
) 2>&1 | tee "$LOG_FILE"
EXIT_CODE=${PIPESTATUS[0]}
END_NS=$(date +%s%N)
DUR_MS=$(( (END_NS - START_NS) / 1000000 ))

if [[ "$EXIT_CODE" == "0" ]]; then
  STATUS=pass
  ERR=""
else
  STATUS=fail
  ERR="exit code ${EXIT_CODE}; see ${USE_CASE}__${FRAMEWORK}.log"
fi

# If the descriptor declares result.convention=result-json AND the example
# wrote a result.json into its working directory, prefer that — runner-contract
# path. Otherwise synthesize from exit code.
AUTHORED="${WORKDIR}/result.json"
if [[ "$FW_RESULT_CONVENTION" == "result-json" && -f "$AUTHORED" ]]; then
  cp "$AUTHORED" "$RESULT_FILE"
  echo "Used authored result.json from ${WORKDIR} (descriptor convention=result-json)"
else
  write_result_json "$STATUS" "$DUR_MS" "$ERR"
fi

if [[ "$STATUS" == "pass" || "$STATUS" == "skipped" ]]; then
  exit 0
else
  exit 1
fi
