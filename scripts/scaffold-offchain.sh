#!/bin/bash
set -e

# Scaffold standalone off-chain skeletons for a new library across all examples.
#
# Usage:
#   scripts/scaffold-offchain.sh <framework-id> [--examples a,b,c] [--force]
#
# Reads the framework's entry from frameworks.json (kind must be "offchain";
# needs runtime/subdir/entryGlob), then stamps a self-contained skeleton entry
# file into every example's off-chain dir from scripts/templates/offchain/.
# Each file is standalone/idiomatic-ready: the boilerplate frame (blueprint load
# by title, yaci config) is copied in; only the transaction logic is left as TODO.
#
# Add the framework to frameworks.json FIRST, then run this. The runner and CI
# pick it up automatically — no other edits required.

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"
REGISTRY="$REPO_ROOT/frameworks.json"
TEMPLATES="$REPO_ROOT/scripts/templates/offchain"

command -v jq &>/dev/null || { echo -e "${RED}jq is required${NC}" >&2; exit 1; }
[ -f "$REGISTRY" ] || { echo -e "${RED}$REGISTRY not found${NC}" >&2; exit 1; }

FRAMEWORK_ID=""; FORCE=false; EXAMPLES_CSV=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=true ;;
    --examples) shift; EXAMPLES_CSV="$1" ;;
    --examples=*) EXAMPLES_CSV="${1#*=}" ;;
    -*) echo -e "${RED}unknown flag: $1${NC}" >&2; exit 1 ;;
    *) FRAMEWORK_ID="$1" ;;
  esac
  shift
done

if [ -z "$FRAMEWORK_ID" ]; then
  echo "Usage: scripts/scaffold-offchain.sh <framework-id> [--examples a,b,c] [--force]" >&2
  echo "Off-chain frameworks in frameworks.json:" >&2
  jq -r '.frameworks[] | select(.kind=="offchain") | "  - \(.id)"' "$REGISTRY" >&2
  exit 1
fi

fw=$(jq -c --arg id "$FRAMEWORK_ID" '.frameworks[] | select(.id==$id)' "$REGISTRY")
[ -n "$fw" ] || { echo -e "${RED}framework '$FRAMEWORK_ID' not in frameworks.json — add it first${NC}" >&2; exit 1; }
[ "$(jq -r '.kind' <<<"$fw")" = "offchain" ] || { echo -e "${RED}'$FRAMEWORK_ID' is not kind=offchain${NC}" >&2; exit 1; }

LABEL=$(jq -r '.label // .id'                                   <<<"$fw")
SUBDIR=$(jq -r '.subdir // (.discoveryPath | sub("/[^/]+$";""))' <<<"$fw")
ENTRY_GLOB=$(jq -r '.entryGlob // "*"'                          <<<"$fw")
RUNTIME=$(jq -r '.runtime // ""'                                <<<"$fw")
DISCOVERY=$(jq -r '.discoveryPath // ""'                        <<<"$fw")
EXT="${ENTRY_GLOB##*.}"

# Map runtime → template file + (optional) marker template.
case "$RUNTIME" in
  deno)   TPL="$TEMPLATES/deno.ts";    MARKER_TPL="$TEMPLATES/deno.json" ;;
  python) TPL="$TEMPLATES/python.py";  MARKER_TPL="$TEMPLATES/requirements.txt" ;;
  jbang)  TPL="$TEMPLATES/jbang.java"; MARKER_TPL="" ;;
  go)     TPL="$TEMPLATES/go.go";     MARKER_TPL="$TEMPLATES/go.mod" ;;
  *) echo -e "${RED}no template for runtime '$RUNTIME' — add scripts/templates/offchain/${NC}" >&2; exit 1 ;;
esac
[ -f "$TPL" ] || { echo -e "${RED}template not found: $TPL${NC}" >&2; exit 1; }

# Separate marker file (e.g. deno.json/requirements.txt) only when discoveryPath
# points at a fixed filename, not a glob like offchain/<lib>/*.java.
MARKER_BASENAME=""
case "$DISCOVERY" in
  *'*'*) MARKER_BASENAME="" ;;          # glob → entry file is the marker
  */*)   MARKER_BASENAME="${DISCOVERY##*/}" ;;
esac

# PascalCase for JVM class names (examples have hyphens, invalid as identifiers).
pascal() {
  local out="" part
  local IFS='-_'
  for part in $1; do
    out="${out}$(printf '%s' "${part:0:1}" | tr '[:lower:]' '[:upper:]')${part:1}"
  done
  printf '%s' "$out"
}

# Example set: explicit list, or every example carrying an Aiken blueprint dir.
examples=()
if [ -n "$EXAMPLES_CSV" ]; then
  IFS=',' read -r -a examples <<<"$EXAMPLES_CSV"
else
  while IFS= read -r d; do examples+=("$(basename "$(dirname "$(dirname "$d")")")"); done \
    < <(find . -maxdepth 4 -path "*/onchain/aiken/aiken.toml" -type f | sort)
fi
[ "${#examples[@]}" -gt 0 ] || { echo -e "${RED}no examples found${NC}" >&2; exit 1; }

echo -e "${BLUE}Scaffolding ${LABEL} (${RUNTIME}) across ${#examples[@]} example(s)${NC}"
echo "  subdir=$SUBDIR  entry=*.${EXT}  template=$(basename "$TPL")"
echo ""

CREATED=0; SKIPPED=0
for example in "${examples[@]}"; do
  [ -n "$example" ] || continue
  dir="$example/$SUBDIR"
  mkdir -p "$dir"

  # Entry file name + class name.
  local_class=$(pascal "$example")

  # Marker file (discovery anchor) — stamp stub if missing. Same placeholder
  # substitution as the entry file below: a no-op for markers without
  # placeholders (deno.json, requirements.txt), required for go.mod's
  # __EXAMPLE__-bearing module path.
  if [ -n "$MARKER_BASENAME" ] && [ -n "$MARKER_TPL" ] && [ ! -f "$dir/$MARKER_BASENAME" ]; then
    sed -e "s/__EXAMPLE__/${example}/g" -e "s/__CLASS__/${local_class}/g" "$MARKER_TPL" > "$dir/$MARKER_BASENAME"
  fi
  if [ "$RUNTIME" = "jbang" ]; then
    entry="${local_class}.${EXT}"
  else
    entry="${example}.${EXT}"
  fi
  target="$dir/$entry"

  if [ -f "$target" ] && [ "$FORCE" != true ]; then
    echo -e "  ${YELLOW}[SKIP]${NC}    $target (exists; --force to overwrite)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  sed -e "s/__EXAMPLE__/${example}/g" -e "s/__CLASS__/${local_class}/g" "$TPL" > "$target"
  echo -e "  ${GREEN}[CREATE]${NC}  $target"
  CREATED=$((CREATED + 1))
done

echo ""
echo -e "${GREEN}Done.${NC} created=$CREATED skipped=$SKIPPED"
echo "Next: implement the TODOs in each entry file, then run:"
echo "  ONLY_FRAMEWORK=${FRAMEWORK_ID} ONLY_EXAMPLE=<example> bash scripts/local-test-offchain.sh"
