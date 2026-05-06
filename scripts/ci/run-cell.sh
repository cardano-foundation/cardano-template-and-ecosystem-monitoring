#!/usr/bin/env bash
#
# Run one (use-case, framework) cell from CI. Resolves the entry file inside
# the working directory by glob, runs the framework's command with $ENTRY
# substituted, captures stdout/stderr to a log, and writes a result.json
# describing pass/fail/duration.
#
# Usage:
#   run-cell.sh <use_case> <framework> <working_dir> <entry_glob> <command> <output_dir>
#
# Environment:
#   PROTOCOL_VERSION_VERSION   the era this run targets (set by load-versions)
#
# Output files in <output_dir>:
#   <use_case>__<framework>.log
#   <use_case>__<framework>.result.json

set -uo pipefail

if [[ $# -lt 6 ]]; then
  echo "usage: $0 <use_case> <framework> <working_dir> <entry_glob> <command> <output_dir>" >&2
  exit 64
fi

USE_CASE="$1"
FRAMEWORK="$2"
WORKDIR="$3"
ENTRY_GLOB="$4"
CMD="$5"
OUT_DIR="$6"

ERA="${PROTOCOL_VERSION_VERSION:-unknown}"

mkdir -p "$OUT_DIR"
LOG_FILE="${OUT_DIR}/${USE_CASE}__${FRAMEWORK}.log"
RESULT_FILE="${OUT_DIR}/${USE_CASE}__${FRAMEWORK}.result.json"

# Resolve entry file: take the first glob match inside the working directory.
ENTRY=""
if [[ -d "$WORKDIR" ]]; then
  shopt -s nullglob
  pushd "$WORKDIR" > /dev/null
  matches=( $ENTRY_GLOB )
  popd > /dev/null
  shopt -u nullglob
  if [[ ${#matches[@]} -gt 0 ]]; then
    ENTRY="${matches[0]}"
  fi
fi

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

if [[ ! -d "$WORKDIR" ]]; then
  echo "::error::working directory $WORKDIR does not exist for ${USE_CASE}/${FRAMEWORK}"
  write_result_json fail 0 "working directory ${WORKDIR} does not exist"
  exit 1
fi

if [[ -z "$ENTRY" ]]; then
  echo "::error::no entry file matching '${ENTRY_GLOB}' in ${WORKDIR}"
  write_result_json fail 0 "no entry file matching ${ENTRY_GLOB}"
  exit 1
fi

echo "Running ${USE_CASE}/${FRAMEWORK}: cd ${WORKDIR} && ${CMD} ${ENTRY}"

START_NS=$(date +%s%N)
(
  cd "$WORKDIR"
  bash -c "${CMD} \"\$0\"" "$ENTRY"
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

# If the example wrote its own result.json into the working directory, prefer
# that — this is the runner-contract path. Fall back to synthesizing one.
AUTHORED="${WORKDIR}/result.json"
if [[ -f "$AUTHORED" ]]; then
  cp "$AUTHORED" "$RESULT_FILE"
  echo "Used authored result.json from ${WORKDIR}"
else
  write_result_json "$STATUS" "$DUR_MS" "$ERR"
fi

if [[ "$STATUS" == "pass" || "$STATUS" == "skipped" ]]; then
  exit 0
else
  exit 1
fi
