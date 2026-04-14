#!/bin/bash
# generate-results.sh
# Generates docs/results.json with all workflow results for the GitHub Pages dashboard.
# Called by the `publish-results` job at the end of the CI workflow.
#
# Required env vars (set automatically by GitHub Actions):
#   GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_REF_NAME
#
# Required env vars (pass explicitly in the workflow step):
#   JOB_DISCOVER, JOB_COMPILE_AIKEN, JOB_TEST_CCL, JOB_TEST_MESH, JOB_TEST_LUCID, JOB_REPORT
#   DURATION_DISCOVER, DURATION_COMPILE_AIKEN, DURATION_TEST_CCL, DURATION_TEST_MESH,
#   DURATION_TEST_LUCID, DURATION_REPORT
#
# Artifact discovery lists are read from .local-test-results/ (produced by the discover job).

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
RESULTS_DIR="$REPO_ROOT/.local-test-results"
OUTPUT_FILE="$REPO_ROOT/docs/results.json"

mkdir -p "$REPO_ROOT/docs"

echo "📦 Generating results.json..."

# ── helpers ──────────────────────────────────────────────────────────────────

# Read a discovery list file and emit a JSON array of strings
list_to_json() {
  local file="$1"
  if [[ -f "$file" ]] && [[ -s "$file" ]]; then
    jq -R -s -c 'split("\n") | map(select(length > 0))' < "$file"
  else
    echo "[]"
  fi
}

# Given a directory of per-example log files, produce a JSON array like:
# [{"name":"hello-world","status":"success"}, ...]
# It infers success from exit-code absence — if the log file exists and does NOT
# contain the string "AssertionError" or "ERROR" it's treated as success.
logs_to_results() {
  local log_dir="$1"
  local prefix="$2"   # e.g. "logs-ccl-"

  local json="["
  local first=true

  while IFS= read -r -d '' dir; do
    local example
    example=$(basename "$dir" | sed "s/^${prefix}//")
    local log_file="$dir/test-output.log"
    local status="failure"

    if [[ -f "$log_file" ]]; then
      if ! grep -qiE "AssertionError|BUILD FAILED|Exception in thread|error\[" "$log_file"; then
        status="success"
      fi
    fi

    [[ "$first" == "false" ]] && json+=","
    json+="{\"name\":\"${example}\",\"status\":\"${status}\"}"
    first=false
  done < <(find "$log_dir" -maxdepth 1 -type d -name "${prefix}*" -print0 2>/dev/null)

  json+="]"
  echo "$json"
}

# ── discovery lists ───────────────────────────────────────────────────────────

AIKEN_LIST=$(list_to_json  "$RESULTS_DIR/aiken-examples.txt")
SCALUS_LIST=$(list_to_json "$RESULTS_DIR/scalus-examples.txt")
CCL_LIST=$(list_to_json    "$RESULTS_DIR/ccl-examples.txt")
MESH_LIST=$(list_to_json   "$RESULTS_DIR/mesh-examples.txt")
LUCID_LIST=$(list_to_json  "$RESULTS_DIR/lucid-examples.txt")

# ── per-example test results ──────────────────────────────────────────────────
# Artifacts are downloaded by the `publish-results` job into ./artifacts/
ARTIFACTS_DIR="${ARTIFACTS_DIR:-$REPO_ROOT/artifacts}"

AIKEN_RESULTS="[]"
CCL_RESULTS="[]"
MESH_RESULTS="[]"
LUCID_RESULTS="[]"

if [[ -d "$ARTIFACTS_DIR" ]]; then
  # Aiken: if plutus.json artifact was downloaded, compilation succeeded
  AIKEN_RESULTS_TMP="["
  first=true
  while IFS= read -r -d '' dir; do
    example=$(basename "$dir" | sed 's/^plutus-//')
    plutus="$dir/plutus.json"
    status="failure"
    [[ -f "$plutus" ]] && status="success"
    [[ "$first" == "false" ]] && AIKEN_RESULTS_TMP+=","
    AIKEN_RESULTS_TMP+="{\"name\":\"${example}\",\"status\":\"${status}\"}"
    first=false
  done < <(find "$ARTIFACTS_DIR" -maxdepth 1 -type d -name "plutus-*" -print0 2>/dev/null)
  AIKEN_RESULTS_TMP+="]"
  [[ "$AIKEN_RESULTS_TMP" != "[]" ]] && AIKEN_RESULTS="$AIKEN_RESULTS_TMP"

  CCL_RESULTS=$(logs_to_results  "$ARTIFACTS_DIR" "logs-ccl-")
  MESH_RESULTS=$(logs_to_results "$ARTIFACTS_DIR" "logs-mesh-")
  LUCID_RESULTS=$(logs_to_results "$ARTIFACTS_DIR" "logs-lucid-")
fi

# ── job statuses ──────────────────────────────────────────────────────────────
# Values: success | failure | skipped | pending
JOB_DISCOVER="${JOB_DISCOVER:-pending}"
JOB_COMPILE_AIKEN="${JOB_COMPILE_AIKEN:-pending}"
JOB_TEST_CCL="${JOB_TEST_CCL:-pending}"
JOB_TEST_MESH="${JOB_TEST_MESH:-pending}"
JOB_TEST_LUCID="${JOB_TEST_LUCID:-pending}"
JOB_REPORT="${JOB_REPORT:-pending}"

DURATION_DISCOVER="${DURATION_DISCOVER:-null}"
DURATION_COMPILE_AIKEN="${DURATION_COMPILE_AIKEN:-null}"
DURATION_TEST_CCL="${DURATION_TEST_CCL:-null}"
DURATION_TEST_MESH="${DURATION_TEST_MESH:-null}"
DURATION_TEST_LUCID="${DURATION_TEST_LUCID:-null}"
DURATION_REPORT="${DURATION_REPORT:-null}"

# ── discovery script raw output ───────────────────────────────────────────────
DISCOVERY_OUTPUT=""
if [[ -f "$RESULTS_DIR/discovery-output.txt" ]]; then
  DISCOVERY_OUTPUT=$(cat "$RESULTS_DIR/discovery-output.txt")
fi

# ── build JSON ────────────────────────────────────────────────────────────────
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
COMMIT_SHA="${GITHUB_SHA:-local}"
BRANCH="${GITHUB_REF_NAME:-local}"
RUN_ID="${GITHUB_RUN_ID:-0}"
REPO="${GITHUB_REPOSITORY:-local/repo}"

WORKFLOW_URL="https://github.com/${REPO}/actions/runs/${RUN_ID}"
COMMIT_URL="https://github.com/${REPO}/commit/${COMMIT_SHA}"

jq -n \
  --arg timestamp       "$TIMESTAMP" \
  --arg branch          "$BRANCH" \
  --arg commit_sha      "$COMMIT_SHA" \
  --arg commit_url      "$COMMIT_URL" \
  --arg workflow_url    "$WORKFLOW_URL" \
  --arg job_discover    "$JOB_DISCOVER" \
  --arg job_aiken       "$JOB_COMPILE_AIKEN" \
  --arg job_ccl         "$JOB_TEST_CCL" \
  --arg job_mesh        "$JOB_TEST_MESH" \
  --arg job_lucid       "$JOB_TEST_LUCID" \
  --arg job_report      "$JOB_REPORT" \
  --argjson dur_discover    "$DURATION_DISCOVER" \
  --argjson dur_aiken       "$DURATION_COMPILE_AIKEN" \
  --argjson dur_ccl         "$DURATION_TEST_CCL" \
  --argjson dur_mesh        "$DURATION_TEST_MESH" \
  --argjson dur_lucid       "$DURATION_TEST_LUCID" \
  --argjson dur_report      "$DURATION_REPORT" \
  --argjson aiken_list      "$AIKEN_LIST" \
  --argjson scalus_list     "$SCALUS_LIST" \
  --argjson ccl_list        "$CCL_LIST" \
  --argjson mesh_list       "$MESH_LIST" \
  --argjson lucid_list      "$LUCID_LIST" \
  --argjson aiken_results   "$AIKEN_RESULTS" \
  --argjson ccl_results     "$CCL_RESULTS" \
  --argjson mesh_results    "$MESH_RESULTS" \
  --argjson lucid_results   "$LUCID_RESULTS" \
  --arg discovery_output "$DISCOVERY_OUTPUT" \
  '{
    run: {
      timestamp:    $timestamp,
      branch:       $branch,
      commit_sha:   $commit_sha,
      commit_url:   $commit_url,
      workflow_url: $workflow_url
    },
    jobs: {
      discover:      { status: $job_discover,  duration_seconds: $dur_discover },
      compile_aiken: { status: $job_aiken,     duration_seconds: $dur_aiken },
      test_ccl_java: { status: $job_ccl,       duration_seconds: $dur_ccl },
      test_mesh:     { status: $job_mesh,      duration_seconds: $dur_mesh },
      test_lucid:    { status: $job_lucid,     duration_seconds: $dur_lucid },
      report:        { status: $job_report,    duration_seconds: $dur_report }
    },
    discovery: {
      aiken:    $aiken_list,
      scalus:   $scalus_list,
      ccl_java: $ccl_list,
      meshjs:   $mesh_list,
      lucid:    $lucid_list
    },
    results: {
      aiken:    $aiken_results,
      ccl_java: $ccl_results,
      meshjs:   $mesh_results,
      lucid:    $lucid_results
    },
    discovery_output: $discovery_output
  }' > "$OUTPUT_FILE"

echo "✅ results.json written to $OUTPUT_FILE"
echo "   $(wc -c < "$OUTPUT_FILE") bytes"
