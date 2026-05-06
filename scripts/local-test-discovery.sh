#!/usr/bin/env bash
#
# Cardano Ecosystem Test Discovery (dual-mode)
#
# Reads <use-case>/example.yml manifests where they exist; falls back to the
# legacy filename heuristics for use cases that haven't been migrated yet.
# This dual-mode is intentional and temporary — it lets P1W1 ship without
# forcing a 21-file manifest migration before the format is reviewed. P1W2
# completes the migration and removes the heuristic fallback.
#
# Outputs (to stdout, GitHub Actions $GITHUB_OUTPUT, and .local-test-results/):
#   - aiken-examples:           JSON array of use-case names with onchain/aiken
#   - ccl-examples:             JSON array of use-case names with offchain/ccl-java
#   - mesh-examples:            JSON array of use-case names with offchain/meshjs
#   - lucid-examples:           JSON array of use-case names with offchain/lucid-evolution
#   - manifest-coverage:        JSON {total, with_manifest, with_heuristic}
#
# Schema reference (manifest): docs/reference/example-manifest.md (lands in P1W2).

set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
DIM='\033[2m'
NC='\033[0m'

echo -e "${BLUE}🔍 Discovering Cardano examples${NC}"
echo "========================================"

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

OUT_DIR=".local-test-results"
mkdir -p "$OUT_DIR"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

AIKEN_FILE="$TMP_DIR/aiken-examples.txt"
SCALUS_FILE="$TMP_DIR/scalus-examples.txt"
CCL_FILE="$TMP_DIR/ccl-examples.txt"
MESH_FILE="$TMP_DIR/mesh-examples.txt"
LUCID_FILE="$TMP_DIR/lucid-examples.txt"
: > "$AIKEN_FILE"
: > "$SCALUS_FILE"
: > "$CCL_FILE"
: > "$MESH_FILE"
: > "$LUCID_FILE"

WITH_MANIFEST=0
WITH_HEURISTIC=0

# ---- Manifest-mode discovery ------------------------------------------------
#
# A use case has a manifest iff <use-case>/example.yml exists. The manifest
# names which onchain languages and offchain SDKs the use case ships, keyed
# by the framework's `manifest_key` from frameworks/<name>.yml. We extract
# those keys and append the use-case name to the matching per-framework list.

# Returns the list of immediate-child keys under a top-level mapping in a
# small flat YAML manifest. Mirrors the parsing in
# .github/actions/run-framework/action.yml so behaviour stays consistent.
manifest_keys_under() {
  local file="$1"
  local section="$2"  # onchain | offchain
  python3 - "$file" "$section" <<'PY'
import re, sys
path = sys.argv[1]
section = sys.argv[2]
with open(path) as fh:
    lines = fh.readlines()
in_section = False
section_indent = -1
for raw in lines:
    line = raw.rstrip("\n")
    stripped = line.lstrip()
    if not stripped or stripped.startswith("#"):
        continue
    indent = len(line) - len(stripped)
    m = re.match(r'([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$', stripped)
    if not m:
        continue
    key, val = m.group(1), m.group(2).strip()
    if not in_section:
        if indent == 0 and key == section and not val:
            in_section = True
            section_indent = indent
        continue
    # Inside the section
    if indent <= section_indent:
        # Left the section
        break
    # Direct children: one indent deeper than the section header
    if (indent == section_indent + 2 or indent == section_indent + 4) and not val:
        # First-time, lock the child indent so we don't accidentally pick
        # grand-children (entry: under each framework key)
        # We rely on the fact that children appear before grandchildren.
        print(key)
PY
}

echo
echo -e "${YELLOW}Manifest-mode discovery${NC}"
for uc_dir in */; do
  uc="${uc_dir%/}"
  manifest="$uc/example.yml"
  [[ -f "$manifest" ]] || continue
  WITH_MANIFEST=$((WITH_MANIFEST + 1))

  printed_uc_label=false
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    if ! $printed_uc_label; then
      echo -e "  ${DIM}$uc${NC}"
      printed_uc_label=true
    fi
    echo "    onchain  $key"
    case "$key" in
      aiken) echo "$uc" >> "$AIKEN_FILE" ;;
      scalus) echo "$uc" >> "$SCALUS_FILE" ;;
      *) echo -e "    ${YELLOW}note${NC} unknown onchain framework key '$key' — no descriptor at frameworks/$key.yml" ;;
    esac
  done < <(manifest_keys_under "$manifest" "onchain" 2>/dev/null)

  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    if ! $printed_uc_label; then
      echo -e "  ${DIM}$uc${NC}"
      printed_uc_label=true
    fi
    echo "    offchain $key"
    case "$key" in
      meshjs) echo "$uc" >> "$MESH_FILE" ;;
      lucid-evolution) echo "$uc" >> "$LUCID_FILE" ;;
      ccl-java) echo "$uc" >> "$CCL_FILE" ;;
      *) echo -e "    ${YELLOW}note${NC} unknown offchain framework key '$key' — no descriptor at frameworks/$key.yml" ;;
    esac
  done < <(manifest_keys_under "$manifest" "offchain" 2>/dev/null)
done

# ---- Legacy heuristic fallback ---------------------------------------------
#
# For use cases without a manifest, fall back to filename-pattern detection.
# Identical logic to the original script. Removed in P1W2 once every use case
# has a manifest.

echo
echo -e "${YELLOW}Heuristic fallback (use cases without example.yml)${NC}"
for uc_dir in */; do
  uc="${uc_dir%/}"
  # Skip non-use-case directories
  [[ -d "$uc/onchain" || -d "$uc/offchain" ]] || continue
  # Skip use cases that already have a manifest
  [[ -f "$uc/example.yml" ]] && continue

  found_anything=false
  if [[ -f "$uc/onchain/aiken/aiken.toml" ]]; then
    echo "$uc" >> "$AIKEN_FILE"
    echo -e "  ${DIM}$uc${NC}  onchain/aiken (heuristic)"
    found_anything=true
  fi
  if [[ -f "$uc/onchain/scalus/build.sbt" ]]; then
    echo "$uc" >> "$SCALUS_FILE"
    echo -e "  ${DIM}$uc${NC}  onchain/scalus (heuristic)"
    found_anything=true
  fi
  if compgen -G "$uc/offchain/ccl-java/*.java" > /dev/null 2>&1; then
    echo "$uc" >> "$CCL_FILE"
    echo -e "  ${DIM}$uc${NC}  offchain/ccl-java (heuristic)"
    found_anything=true
  fi
  if [[ -f "$uc/offchain/meshjs/deno.json" ]]; then
    echo "$uc" >> "$MESH_FILE"
    echo -e "  ${DIM}$uc${NC}  offchain/meshjs (heuristic)"
    found_anything=true
  fi
  if [[ -f "$uc/offchain/lucid-evolution/deno.json" ]]; then
    echo "$uc" >> "$LUCID_FILE"
    echo -e "  ${DIM}$uc${NC}  offchain/lucid-evolution (heuristic)"
    found_anything=true
  fi
  $found_anything && WITH_HEURISTIC=$((WITH_HEURISTIC + 1)) || true
done

# Deduplicate (manifest mode + heuristic mode could double-count if a future
# bug ever surfaced — defensive programming).
for f in "$AIKEN_FILE" "$SCALUS_FILE" "$CCL_FILE" "$MESH_FILE" "$LUCID_FILE"; do
  sort -u -o "$f" "$f"
done

# ---- Output ----------------------------------------------------------------

count_lines() { wc -l < "$1" | tr -d ' '; }
AIKEN_COUNT=$(count_lines "$AIKEN_FILE")
SCALUS_COUNT=$(count_lines "$SCALUS_FILE")
CCL_COUNT=$(count_lines "$CCL_FILE")
MESH_COUNT=$(count_lines "$MESH_FILE")
LUCID_COUNT=$(count_lines "$LUCID_FILE")
TOTAL=$((AIKEN_COUNT + SCALUS_COUNT + CCL_COUNT + MESH_COUNT + LUCID_COUNT))

echo
echo -e "${GREEN}========================================"
echo "Discovery summary"
echo "========================================${NC}"
printf "  Manifest-mode use cases:    %d\n"  "$WITH_MANIFEST"
printf "  Heuristic-mode use cases:   %d\n"  "$WITH_HEURISTIC"
echo "  ----------------------------------------"
printf "  Aiken examples:             %d\n"  "$AIKEN_COUNT"
printf "  Scalus examples:            %d\n"  "$SCALUS_COUNT"
printf "  CCL Java examples:          %d\n"  "$CCL_COUNT"
printf "  Mesh.js examples:           %d\n"  "$MESH_COUNT"
printf "  Lucid Evolution examples:   %d\n"  "$LUCID_COUNT"
echo "  ----------------------------------------"
printf "  Total cells:                %d\n"  "$TOTAL"
echo

# JSON-array output
to_json_array() {
  python3 -c "
import json, sys
items = [line.strip() for line in open(sys.argv[1]) if line.strip()]
print(json.dumps(items))
" "$1"
}

AIKEN_JSON=$(to_json_array "$AIKEN_FILE")
SCALUS_JSON=$(to_json_array "$SCALUS_FILE")
CCL_JSON=$(to_json_array "$CCL_FILE")
MESH_JSON=$(to_json_array "$MESH_FILE")
LUCID_JSON=$(to_json_array "$LUCID_FILE")

# Union of all offchain framework lists — one matrix axis driving the
# collapsed-offchain CI job (matrix={use_case}, one job per use case running
# every declared offchain framework against a shared Yaci).
USE_CASES_WITH_OFFCHAIN=$(cat "$CCL_FILE" "$MESH_FILE" "$LUCID_FILE" 2>/dev/null | sort -u)
echo "$USE_CASES_WITH_OFFCHAIN" > "$OUT_DIR/use-cases-with-offchain.txt"
USE_CASES_WITH_OFFCHAIN_JSON=$(echo "$USE_CASES_WITH_OFFCHAIN" \
  | python3 -c "
import json, sys
items = [line.strip() for line in sys.stdin if line.strip()]
print(json.dumps(items))
")

# GitHub Actions output
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "aiken-examples=$AIKEN_JSON"
    echo "scalus-examples=$SCALUS_JSON"
    echo "ccl-examples=$CCL_JSON"
    echo "mesh-examples=$MESH_JSON"
    echo "lucid-examples=$LUCID_JSON"
    echo "use-cases-with-offchain=$USE_CASES_WITH_OFFCHAIN_JSON"
    echo "manifest-coverage={\"total\":$((WITH_MANIFEST + WITH_HEURISTIC)),\"with_manifest\":$WITH_MANIFEST,\"with_heuristic\":$WITH_HEURISTIC}"
  } >> "$GITHUB_OUTPUT"
fi

# Local artifacts (used by local-test-*.sh)
cp "$AIKEN_FILE"  "$OUT_DIR/aiken-examples.txt"
cp "$SCALUS_FILE" "$OUT_DIR/scalus-examples.txt"
cp "$CCL_FILE"    "$OUT_DIR/ccl-examples.txt"
cp "$MESH_FILE"   "$OUT_DIR/mesh-examples.txt"
cp "$LUCID_FILE"  "$OUT_DIR/lucid-examples.txt"

echo -e "${GREEN}✅ Discovery complete${NC}  (${WITH_HEURISTIC} use cases still using heuristic fallback — migrate them in P1W2)"
