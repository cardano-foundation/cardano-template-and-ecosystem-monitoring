#!/usr/bin/env bash
#
# Cardano Ecosystem Test Discovery (registry-driven, dual-mode).
#
# Enumerates `frameworks/*.yml` to discover which onchain languages and
# offchain SDKs are registered, then walks every use case and decides which
# of those frameworks each use case ships:
#
#   * Manifest mode (preferred): use cases with `<use-case>/example.yml`
#     declare frameworks explicitly via `manifest_key` keys under onchain:
#     and offchain:.
#   * Heuristic mode (fallback): use cases without a manifest are matched by
#     directory presence — `<use-case>/<run.cwd_relative_to_example>` must
#     exist for the framework to be considered present.
#
# This dual-mode is intentional and temporary — it lets P1W1 ship without
# forcing a 21-file manifest migration before the format is reviewed.
# P1W2 completes the migration and removes the heuristic fallback.
#
# Adding a new framework = one new descriptor under `frameworks/`. This
# script reads it and any matching use case is automatically discovered.
# No edits to this script are required.
#
# Outputs (to stdout, GitHub Actions $GITHUB_OUTPUT, and .local-test-results/):
#   - <fw>-examples (one per registered framework, e.g. `aiken-examples`,
#     `meshjs-examples`, `lucid-evolution-examples`, `ccl-java-examples`):
#       JSON array of use-case names
#   - registered-onchain:        JSON array of registered onchain framework names
#   - registered-offchain:       JSON array of registered offchain framework names
#   - use-cases-with-offchain:   JSON array of use cases with ≥ 1 offchain framework
#   - manifest-coverage:         JSON {total, with_manifest, with_heuristic}
#
# Schema reference (manifest):    docs/reference/example-manifest.md (lands in P1W2)
# Schema reference (descriptors): frameworks/SCHEMA.md

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

# Per-framework example lists are built dynamically. Each registered framework
# gets a TMP_DIR/<fw>.txt file populated during the scan.
WITH_MANIFEST=0
WITH_HEURISTIC=0

# Returns the value of a dotted-path field from a small flat-or-shallow YAML
# file. See frameworks/SCHEMA.md for the YAML subset we support.
yaml_get() {
  local file="$1"
  local path="$2"
  YAML_FILE="$file" YAML_PATH="$path" python3 - <<'PY'
import os, re
target = os.environ["YAML_PATH"]
out = None
with open(os.environ["YAML_FILE"]) as fh:
    lines = fh.readlines()
stack = []
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

# Returns the immediate-child keys of a top-level YAML mapping (e.g. all
# framework keys under `offchain:`).
manifest_keys_under() {
  local file="$1"
  local section="$2"
  YAML_FILE="$file" YAML_SECTION="$section" python3 - <<'PY'
import os, re
section = os.environ["YAML_SECTION"]
with open(os.environ["YAML_FILE"]) as fh:
    lines = fh.readlines()
in_section, section_indent = False, -1
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
            in_section, section_indent = True, indent
        continue
    if indent <= section_indent:
        break
    if (indent == section_indent + 2 or indent == section_indent + 4) and not val:
        print(key)
PY
}

# ---- Step 1: enumerate registered frameworks ------------------------------

if [[ ! -d frameworks ]] || [[ -z "$(ls frameworks/*.yml 2>/dev/null)" ]]; then
  echo "::error::no frameworks/*.yml descriptors found — register at least one before running discovery"
  exit 1
fi

declare -a ONCHAIN_FRAMEWORKS=()
declare -a OFFCHAIN_FRAMEWORKS=()
declare -A FRAMEWORK_KIND=()
declare -A FRAMEWORK_MANIFEST_KEY=()
declare -A FRAMEWORK_CWD=()

echo
echo -e "${YELLOW}Registered framework descriptors${NC}"
for fw_file in frameworks/*.yml; do
  fw=$(basename "$fw_file" .yml)
  # Skip non-descriptor files like SCHEMA.md (compgen guards above)
  [[ "$fw_file" == "frameworks/SCHEMA.md" ]] && continue

  kind=$(yaml_get "$fw_file" "kind")
  manifest_key=$(yaml_get "$fw_file" "manifest_key")
  cwd=$(yaml_get "$fw_file" "run.cwd_relative_to_example")
  : "${manifest_key:=$fw}"

  if [[ -z "$kind" ]]; then
    echo -e "  ${YELLOW}skip${NC} $fw — descriptor missing kind:"
    continue
  fi
  if [[ -z "$cwd" ]]; then
    echo -e "  ${YELLOW}skip${NC} $fw — descriptor missing run.cwd_relative_to_example:"
    continue
  fi

  FRAMEWORK_KIND[$fw]="$kind"
  FRAMEWORK_MANIFEST_KEY[$fw]="$manifest_key"
  FRAMEWORK_CWD[$fw]="$cwd"

  # Initialize per-framework list file
  : > "$TMP_DIR/$fw.txt"

  echo -e "  ${DIM}$fw${NC}  kind=$kind  manifest_key=$manifest_key  cwd=$cwd"
  case "$kind" in
    onchain)  ONCHAIN_FRAMEWORKS+=("$fw")  ;;
    offchain) OFFCHAIN_FRAMEWORKS+=("$fw") ;;
    *) echo -e "  ${YELLOW}note${NC} $fw has unknown kind '$kind' — must be onchain|offchain" ;;
  esac
done

# Lookup map: manifest_key -> framework name (used to resolve manifest entries)
declare -A KEY_TO_FRAMEWORK=()
for fw in "${ONCHAIN_FRAMEWORKS[@]:-}" "${OFFCHAIN_FRAMEWORKS[@]:-}"; do
  [[ -z "$fw" ]] && continue
  KEY_TO_FRAMEWORK["${FRAMEWORK_MANIFEST_KEY[$fw]}"]="$fw"
done

# ---- Step 2: manifest-mode discovery --------------------------------------

# Per-use-case offchain framework lists (descriptor names, manifest_keys
# resolved). Written to ${TMP_DIR}/uc/<use_case>.offchain.txt and copied to
# .local-test-results/. The workflow reads these directly so it never has to
# re-implement manifest_key → descriptor-name resolution.
mkdir -p "$TMP_DIR/uc"

echo
echo -e "${YELLOW}Manifest-mode discovery${NC}"
for uc_dir in */; do
  uc="${uc_dir%/}"
  manifest="$uc/example.yml"
  [[ -f "$manifest" ]] || continue
  WITH_MANIFEST=$((WITH_MANIFEST + 1))

  : > "$TMP_DIR/uc/${uc}.offchain.txt"
  printed_uc_label=false
  for section in onchain offchain; do
    while IFS= read -r key; do
      [[ -z "$key" ]] && continue
      if ! $printed_uc_label; then
        echo -e "  ${DIM}$uc${NC}"
        printed_uc_label=true
      fi
      fw="${KEY_TO_FRAMEWORK[$key]:-}"
      if [[ -z "$fw" ]]; then
        echo -e "    ${YELLOW}note${NC} ${section}.${key} — no descriptor at frameworks/${key}.yml or no descriptor with manifest_key=${key}"
        continue
      fi
      if [[ "${FRAMEWORK_KIND[$fw]}" != "$section" ]]; then
        echo -e "    ${YELLOW}note${NC} ${section}.${key} — descriptor's kind (${FRAMEWORK_KIND[$fw]}) does not match section"
        continue
      fi
      echo "    $section $fw"
      echo "$uc" >> "$TMP_DIR/$fw.txt"
      if [[ "$section" == "offchain" ]]; then
        echo "$fw" >> "$TMP_DIR/uc/${uc}.offchain.txt"
      fi
    done < <(manifest_keys_under "$manifest" "$section" 2>/dev/null)
  done
done

# ---- Step 3: heuristic fallback ------------------------------------------
#
# For use cases without a manifest, presence of <use-case>/<run.cwd> is the
# trigger. This is generic over any registered framework — adding a new
# framework descriptor whose run.cwd points at e.g. "offchain/blaze" picks
# up unmanifested examples automatically.

echo
echo -e "${YELLOW}Heuristic fallback (use cases without example.yml)${NC}"
for uc_dir in */; do
  uc="${uc_dir%/}"
  [[ -d "$uc/onchain" || -d "$uc/offchain" ]] || continue
  [[ -f "$uc/example.yml" ]] && continue

  found_anything=false
  : > "$TMP_DIR/uc/${uc}.offchain.txt"
  for fw in "${ONCHAIN_FRAMEWORKS[@]:-}" "${OFFCHAIN_FRAMEWORKS[@]:-}"; do
    [[ -z "$fw" ]] && continue
    cwd="${FRAMEWORK_CWD[$fw]}"
    if [[ -d "$uc/$cwd" ]]; then
      echo "$uc" >> "$TMP_DIR/$fw.txt"
      echo -e "  ${DIM}$uc${NC}  ${FRAMEWORK_KIND[$fw]}/$fw (heuristic, found $uc/$cwd)"
      found_anything=true
      if [[ "${FRAMEWORK_KIND[$fw]}" == "offchain" ]]; then
        echo "$fw" >> "$TMP_DIR/uc/${uc}.offchain.txt"
      fi
    fi
  done
  $found_anything && WITH_HEURISTIC=$((WITH_HEURISTIC + 1)) || true
done

# Deduplicate (manifest mode + heuristic mode could double-count)
for fw in "${ONCHAIN_FRAMEWORKS[@]:-}" "${OFFCHAIN_FRAMEWORKS[@]:-}"; do
  [[ -z "$fw" ]] && continue
  sort -u -o "$TMP_DIR/$fw.txt" "$TMP_DIR/$fw.txt"
done

# ---- Step 4: summary + outputs --------------------------------------------

count_lines() { [[ -f "$1" ]] && wc -l < "$1" | tr -d ' ' || echo 0; }

echo
echo -e "${GREEN}========================================"
echo "Discovery summary"
echo "========================================${NC}"
printf "  Manifest-mode use cases:    %d\n"  "$WITH_MANIFEST"
printf "  Heuristic-mode use cases:   %d\n"  "$WITH_HEURISTIC"
echo "  ----------------------------------------"
TOTAL=0
for fw in "${ONCHAIN_FRAMEWORKS[@]:-}" "${OFFCHAIN_FRAMEWORKS[@]:-}"; do
  [[ -z "$fw" ]] && continue
  c=$(count_lines "$TMP_DIR/$fw.txt")
  TOTAL=$((TOTAL + c))
  printf "  %-26s %d\n" "$fw examples:" "$c"
done
echo "  ----------------------------------------"
printf "  Total cells:                %d\n"  "$TOTAL"
echo

to_json_array() {
  python3 -c "
import json, sys
items = [line.strip() for line in open(sys.argv[1]) if line.strip()] if sys.argv[1] else []
print(json.dumps(items))
" "$1"
}

# Build use-cases-with-offchain by union of all offchain framework lists
USE_CASES_WITH_OFFCHAIN_FILE="$TMP_DIR/use-cases-with-offchain.txt"
: > "$USE_CASES_WITH_OFFCHAIN_FILE"
for fw in "${OFFCHAIN_FRAMEWORKS[@]:-}"; do
  [[ -z "$fw" ]] && continue
  cat "$TMP_DIR/$fw.txt" >> "$USE_CASES_WITH_OFFCHAIN_FILE"
done
sort -u -o "$USE_CASES_WITH_OFFCHAIN_FILE" "$USE_CASES_WITH_OFFCHAIN_FILE"
USE_CASES_WITH_OFFCHAIN_JSON=$(to_json_array "$USE_CASES_WITH_OFFCHAIN_FILE")

# Per-framework JSON arrays
declare -A FW_JSON=()
for fw in "${ONCHAIN_FRAMEWORKS[@]:-}" "${OFFCHAIN_FRAMEWORKS[@]:-}"; do
  [[ -z "$fw" ]] && continue
  FW_JSON[$fw]=$(to_json_array "$TMP_DIR/$fw.txt")
done

ONCHAIN_JSON=$(printf '%s\n' "${ONCHAIN_FRAMEWORKS[@]:-}" \
  | python3 -c "import json, sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")
OFFCHAIN_JSON=$(printf '%s\n' "${OFFCHAIN_FRAMEWORKS[@]:-}" \
  | python3 -c "import json, sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))")

# GitHub Actions output
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "registered-onchain=$ONCHAIN_JSON"
    echo "registered-offchain=$OFFCHAIN_JSON"
    echo "use-cases-with-offchain=$USE_CASES_WITH_OFFCHAIN_JSON"
    for fw in "${ONCHAIN_FRAMEWORKS[@]:-}" "${OFFCHAIN_FRAMEWORKS[@]:-}"; do
      [[ -z "$fw" ]] && continue
      echo "${fw}-examples=${FW_JSON[$fw]}"
    done
    echo "manifest-coverage={\"total\":$((WITH_MANIFEST + WITH_HEURISTIC)),\"with_manifest\":$WITH_MANIFEST,\"with_heuristic\":$WITH_HEURISTIC}"
  } >> "$GITHUB_OUTPUT"
fi

# Local artifacts
for fw in "${ONCHAIN_FRAMEWORKS[@]:-}" "${OFFCHAIN_FRAMEWORKS[@]:-}"; do
  [[ -z "$fw" ]] && continue
  cp "$TMP_DIR/$fw.txt" "$OUT_DIR/${fw}-examples.txt"
done
cp "$USE_CASES_WITH_OFFCHAIN_FILE" "$OUT_DIR/use-cases-with-offchain.txt"

# Per-use-case offchain framework lists (descriptor names, manifest_keys
# already resolved). Workflow reads these to decide which cells to run.
mkdir -p "$OUT_DIR/uc"
if compgen -G "$TMP_DIR/uc/*.offchain.txt" > /dev/null; then
  cp "$TMP_DIR"/uc/*.offchain.txt "$OUT_DIR/uc/" 2>/dev/null || true
fi

echo -e "${GREEN}✅ Discovery complete${NC}  (${WITH_HEURISTIC} use cases still using heuristic fallback — migrate them in P1W2)"
