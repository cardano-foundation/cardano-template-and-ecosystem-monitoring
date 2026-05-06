#!/usr/bin/env bash
#
# Run every primitive scenario across every registered offchain adapter, locally.
#
# Usage:
#   scripts/run-conformance.sh                            # all primitives, all adapters
#   scripts/run-conformance.sh encoding/datum-cbor-roundtrip  # one primitive
#
# Output:
#   .ci-results/<scenario-id>__<framework>.result.json    per cell
#   .ci-results/<scenario-id>__<framework>.log            per cell
#
# Aggregation + rendering (so the local report shape matches CI):
#   scripts/aggregate-results.sh .ci-results matrix.json
#   scripts/render-matrix.sh matrix.json
#
# Note: P2W1 ships the conformance/ tree and adapter scaffolding; CI wiring
# (a `primitives` matrix job in .github/workflows/ecosystem-test.yml that
# invokes this script) is deferred to a follow-on iteration. This script
# works locally today.

set -uo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

PRIMITIVE_FILTER="${1:-}"

mkdir -p .ci-results

# Discover registered offchain adapters: each subdirectory under
# conformance/adapters/ that has a run-primitive.sh wrapper.
declare -a ADAPTERS=()
for adapter_dir in conformance/adapters/*/; do
  [[ -d "$adapter_dir" ]] || continue
  if [[ -x "${adapter_dir}run-primitive.sh" ]]; then
    ADAPTERS+=("$(basename "$adapter_dir")")
  fi
done

if [[ ${#ADAPTERS[@]} -eq 0 ]]; then
  echo "::error::no adapters with run-primitive.sh found under conformance/adapters/" >&2
  exit 1
fi

# Discover scenario JSONs under conformance/primitives/<id>/scenarios/<era>/.
declare -a SCENARIOS=()
while IFS= read -r f; do
  SCENARIOS+=("$f")
done < <(find conformance/primitives -path '*/scenarios/*' -name '*.json' -type f | sort)

if [[ -n "$PRIMITIVE_FILTER" ]]; then
  filtered=()
  for s in "${SCENARIOS[@]}"; do
    if [[ "$s" == conformance/primitives/${PRIMITIVE_FILTER}/* ]]; then
      filtered+=("$s")
    fi
  done
  SCENARIOS=("${filtered[@]:-}")
fi

if [[ ${#SCENARIOS[@]} -eq 0 ]]; then
  echo "::warning::no scenarios matched filter '${PRIMITIVE_FILTER}'" >&2
  exit 0
fi

TOTAL=0
FAILURES=0

for scenario in "${SCENARIOS[@]}"; do
  scenario_id=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['id'])" "$scenario")
  scenario_id_safe="${scenario_id//\//__}"

  for adapter in "${ADAPTERS[@]}"; do
    [[ -z "$adapter" ]] && continue
    TOTAL=$((TOTAL + 1))
    cell="${scenario_id_safe}__${adapter}"
    log_file=".ci-results/${cell}.log"
    result_file=".ci-results/${cell}.result.json"

    # Run the adapter from a temp directory so its result.json doesn't collide.
    tmp=$(mktemp -d)
    echo
    echo "::group::${scenario_id} / ${adapter}"
    if (cd "$tmp" && "${REPO_ROOT}/conformance/adapters/${adapter}/run-primitive.sh" "${REPO_ROOT}/${scenario}") > "${REPO_ROOT}/${log_file}" 2>&1; then
      echo "  ✅ ${scenario_id} / ${adapter}"
    else
      echo "  ❌ ${scenario_id} / ${adapter}"
      FAILURES=$((FAILURES + 1))
    fi

    if [[ -f "$tmp/result.json" ]]; then
      mv "$tmp/result.json" "${REPO_ROOT}/${result_file}"
    fi
    rm -rf "$tmp"
    echo "::endgroup::"
  done
done

echo
echo "Ran ${TOTAL} cell(s); ${FAILURES} failed."
[[ "$FAILURES" -gt 0 ]] && exit 1 || exit 0
