#!/bin/bash

# Cardano Ecosystem Test Discovery Script
# Iterates over frameworks.json and discovers examples per framework.
# Output file naming and $GITHUB_OUTPUT keys use each framework's statusPrefix
# (`<statusPrefix>-examples.txt` / `<statusPrefix>-examples=...`) so they stay
# stable across registry edits and the existing workflow keeps working.

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

REGISTRY="$REPO_ROOT/frameworks.json"

if ! command -v jq &>/dev/null; then
  echo -e "${RED}ERROR: jq is required but not installed.${NC}" >&2
  exit 1
fi

if [ ! -f "$REGISTRY" ]; then
  echo -e "${RED}ERROR: $REGISTRY not found.${NC}" >&2
  exit 1
fi

echo -e "${BLUE}🔍 Discovering Cardano Examples${NC}"
echo "========================================"
echo ""

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

mkdir -p .local-test-results

TOTAL=0

# Iterate over each framework in the registry.
# jq -c emits one compact JSON object per line.
while IFS= read -r framework; do
  id=$(printf '%s' "$framework"           | jq -r '.id')
  label=$(printf '%s' "$framework"        | jq -r '.label')
  discoveryPath=$(printf '%s' "$framework"| jq -r '.discoveryPath')
  prefix=$(printf '%s' "$framework"       | jq -r '.statusPrefix')

  out="$TEMP_DIR/${prefix}-examples.txt"
  : > "$out"

  echo -e "${YELLOW}Scanning for ${label} examples...${NC}"
  while IFS= read -r file; do
    [ -f "$file" ] || continue
    # Path shape: ./<example>/<discoveryPath...>
    example=$(echo "$file" | cut -d'/' -f2)
    # Avoid duplicates (e.g. multiple .java files under one ccl-java/ dir)
    grep -q "^${example}$" "$out" 2>/dev/null && continue
    echo "$example" >> "$out"
    echo "  - $example"
  done < <(find . -maxdepth 4 -path "*/${discoveryPath}" -type f 2>/dev/null)

  count=$(grep -c . "$out" 2>/dev/null || true)
  count=${count:-0}
  TOTAL=$((TOTAL + count))

  # Save for local consumers (dashboard, version check, etc.)
  cp "$out" ".local-test-results/${prefix}-examples.txt"

  # Emit $GITHUB_OUTPUT key for matrix strategies in the workflow.
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    json_array=$(jq -R -s -c 'split("\n") | map(select(length > 0))' < "$out")
    printf '%s-examples=%s\n' "$prefix" "$json_array" >> "$GITHUB_OUTPUT"
  fi

  echo ""
done < <(jq -c '.frameworks[]' "$REGISTRY")

# Print summary (one line per framework, in registry order).
echo -e "${GREEN}========================================"
echo "Discovery Summary"
echo -e "========================================${NC}"
while IFS= read -r framework; do
  label=$(printf '%s' "$framework" | jq -r '.label')
  prefix=$(printf '%s' "$framework" | jq -r '.statusPrefix')
  count=$(grep -c . ".local-test-results/${prefix}-examples.txt" 2>/dev/null || true)
  count=${count:-0}
  printf "%-26s %s\n" "${label} examples:" "$count"
done < <(jq -c '.frameworks[]' "$REGISTRY")
echo "----------------------------------------"
printf "%-26s %s\n" "Total:" "$TOTAL"
echo ""

echo -e "${GREEN}✅ Discovery complete!${NC}"
