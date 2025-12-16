#!/bin/bash

# Cardano Ecosystem Test Discovery Script
# Automatically discovers all examples by technology stack

set -e

# Color codes for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔍 Discovering Cardano Examples${NC}"
echo "========================================"
echo ""

# Get repository root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

# Create temporary files for results
TEMP_DIR=$(mktemp -d)
AIKEN_EXAMPLES="$TEMP_DIR/aiken-examples.txt"
SCALUS_EXAMPLES="$TEMP_DIR/scalus-examples.txt"
CCL_EXAMPLES="$TEMP_DIR/ccl-examples.txt"
MESH_EXAMPLES="$TEMP_DIR/mesh-examples.txt"
LUCID_EXAMPLES="$TEMP_DIR/lucid-examples.txt"

# Initialize files
touch "$AIKEN_EXAMPLES" "$SCALUS_EXAMPLES" "$CCL_EXAMPLES" "$MESH_EXAMPLES" "$LUCID_EXAMPLES"

# Discover Aiken examples
echo -e "${YELLOW}Scanning for Aiken examples...${NC}"
while IFS= read -r file; do
  if [[ -f "$file" ]]; then
    # Extract use-case name from path
    example=$(echo "$file" | cut -d'/' -f2)
    echo "$example" >> "$AIKEN_EXAMPLES"
    echo "  - $example"
  fi
done < <(find . -maxdepth 4 -path "*/onchain/aiken/aiken.toml" -type f)

# Discover Scalus examples
echo ""
echo -e "${YELLOW}Scanning for Scalus examples...${NC}"
while IFS= read -r file; do
  if [[ -f "$file" ]]; then
    example=$(echo "$file" | cut -d'/' -f2)
    echo "$example" >> "$SCALUS_EXAMPLES"
    echo "  - $example"
  fi
done < <(find . -maxdepth 4 -path "*/onchain/scalus/build.sbt" -type f)

# Discover CCL Java examples
echo ""
echo -e "${YELLOW}Scanning for CCL Java examples...${NC}"
while IFS= read -r file; do
  if [[ -f "$file" ]]; then
    example=$(echo "$file" | cut -d'/' -f2)
    # Avoid duplicates
    if ! grep -q "^$example$" "$CCL_EXAMPLES" 2>/dev/null; then
      echo "$example" >> "$CCL_EXAMPLES"
      echo "  - $example"
    fi
  fi
done < <(find . -maxdepth 4 -path "*/offchain/ccl-java/*.java" -type f)

# Discover Mesh.js examples
echo ""
echo -e "${YELLOW}Scanning for Mesh.js examples...${NC}"
while IFS= read -r file; do
  if [[ -f "$file" ]]; then
    example=$(echo "$file" | cut -d'/' -f2)
    echo "$example" >> "$MESH_EXAMPLES"
    echo "  - $example"
  fi
done < <(find . -maxdepth 4 -path "*/offchain/meshjs/deno.json" -type f)

# Discover Lucid Evolution examples
echo ""
echo -e "${YELLOW}Scanning for Lucid Evolution examples...${NC}"
while IFS= read -r file; do
  if [[ -f "$file" ]]; then
    example=$(echo "$file" | cut -d'/' -f2)
    echo "$example" >> "$LUCID_EXAMPLES"
    echo "  - $example"
  fi
done < <(find . -maxdepth 4 -path "*/offchain/lucid-evolution/deno.json" -type f)

# Count results
AIKEN_COUNT=$(grep -c . "$AIKEN_EXAMPLES" 2>/dev/null || echo 0)
SCALUS_COUNT=$(grep -c . "$SCALUS_EXAMPLES" 2>/dev/null || echo 0)
CCL_COUNT=$(grep -c . "$CCL_EXAMPLES" 2>/dev/null || echo 0)
MESH_COUNT=$(grep -c . "$MESH_EXAMPLES" 2>/dev/null || echo 0)
LUCID_COUNT=$(grep -c . "$LUCID_EXAMPLES" 2>/dev/null || echo 0)
TOTAL=$((AIKEN_COUNT + SCALUS_COUNT + CCL_COUNT + MESH_COUNT + LUCID_COUNT))

# Print summary
echo ""
echo -e "${GREEN}========================================"
echo "Discovery Summary"
echo "========================================${NC}"
echo "Aiken examples:          $AIKEN_COUNT"
echo "Scalus examples:         $SCALUS_COUNT"
echo "CCL Java examples:       $CCL_COUNT"
echo "Mesh.js examples:        $MESH_COUNT"
echo "Lucid Evolution examples: $LUCID_COUNT"
echo "----------------------------------------"
echo "Total:                   $TOTAL"
echo ""

# For GitHub Actions: Export as JSON arrays
if [[ "${GITHUB_OUTPUT:-}" != "" ]]; then
  echo "aiken-examples=$(cat "$AIKEN_EXAMPLES" | jq -R -s -c 'split("\n") | map(select(length > 0))')" >> "$GITHUB_OUTPUT"
  echo "scalus-examples=$(cat "$SCALUS_EXAMPLES" | jq -R -s -c 'split("\n") | map(select(length > 0))')" >> "$GITHUB_OUTPUT"
  echo "ccl-examples=$(cat "$CCL_EXAMPLES" | jq -R -s -c 'split("\n") | map(select(length > 0))')" >> "$GITHUB_OUTPUT"
  echo "mesh-examples=$(cat "$MESH_EXAMPLES" | jq -R -s -c 'split("\n") | map(select(length > 0))')" >> "$GITHUB_OUTPUT"
  echo "lucid-examples=$(cat "$LUCID_EXAMPLES" | jq -R -s -c 'split("\n") | map(select(length > 0))')" >> "$GITHUB_OUTPUT"
fi

# Save for local use
mkdir -p .local-test-results
cp "$AIKEN_EXAMPLES" .local-test-results/aiken-examples.txt
cp "$SCALUS_EXAMPLES" .local-test-results/scalus-examples.txt
cp "$CCL_EXAMPLES" .local-test-results/ccl-examples.txt
cp "$MESH_EXAMPLES" .local-test-results/mesh-examples.txt
cp "$LUCID_EXAMPLES" .local-test-results/lucid-examples.txt

# Cleanup
rm -rf "$TEMP_DIR"

echo -e "${GREEN}✅ Discovery complete!${NC}"
