#!/bin/bash

# Cardano Ecosystem Aiken Compilation Script
# Compiles all Aiken examples and reports results

set -e

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔨 Compiling Aiken Examples${NC}"
echo "========================================"
echo ""

# Get repository root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

# Create results directory
RESULTS_DIR=".local-test-results"
mkdir -p "$RESULTS_DIR"

# Check if Aiken is installed
if ! command -v aiken &> /dev/null; then
  echo -e "${RED}❌ Aiken is not installed${NC}"
  echo "Install it from: https://aiken-lang.org/installation-instructions"
  exit 1
fi

AIKEN_VERSION=$(aiken --version)
echo -e "${GREEN}Aiken version: $AIKEN_VERSION${NC}"
echo ""

# Counters
TOTAL=0
PASSED=0
FAILED=0

# Find and compile all Aiken examples
while IFS= read -r aiken_toml; do
  if [[ ! -f "$aiken_toml" ]]; then
    continue
  fi

  DIR=$(dirname "$aiken_toml")
  EXAMPLE=$(echo "$DIR" | cut -d'/' -f2)

  TOTAL=$((TOTAL + 1))

  echo -e "${YELLOW}📦 [$TOTAL] Testing: $EXAMPLE${NC}"
  echo "   Path: $DIR"

  cd "$DIR"

  # Run aiken check
  echo -n "   Running aiken check... "
  if aiken check > "$REPO_ROOT/$RESULTS_DIR/aiken-$EXAMPLE-check.log" 2>&1; then
    echo -e "${GREEN}✅${NC}"
    CHECK_PASSED=true
  else
    echo -e "${RED}❌${NC}"
    CHECK_PASSED=false
    cat "$REPO_ROOT/$RESULTS_DIR/aiken-$EXAMPLE-check.log"
  fi

  # Run aiken build
  echo -n "   Running aiken build... "
  if aiken build > "$REPO_ROOT/$RESULTS_DIR/aiken-$EXAMPLE-build.log" 2>&1; then
    echo -e "${GREEN}✅${NC}"
    BUILD_PASSED=true
  else
    echo -e "${RED}❌${NC}"
    BUILD_PASSED=false
    cat "$REPO_ROOT/$RESULTS_DIR/aiken-$EXAMPLE-build.log"
  fi

  # Verify plutus.json exists
  if [[ -f "plutus.json" ]]; then
    echo -e "   ${GREEN}✅ plutus.json generated${NC}"
    PLUTUS_SIZE=$(wc -c < plutus.json)
    echo "   Size: $PLUTUS_SIZE bytes"
  else
    echo -e "   ${RED}❌ plutus.json NOT found${NC}"
    BUILD_PASSED=false
  fi

  # Update counters
  if [[ "$CHECK_PASSED" == true && "$BUILD_PASSED" == true ]]; then
    PASSED=$((PASSED + 1))
    echo -e "   ${GREEN}Status: PASSED ✅${NC}"
    echo "success" > "$REPO_ROOT/$RESULTS_DIR/aiken-$EXAMPLE-status.txt"
  else
    FAILED=$((FAILED + 1))
    echo -e "   ${RED}Status: FAILED ❌${NC}"
    echo "failed" > "$REPO_ROOT/$RESULTS_DIR/aiken-$EXAMPLE-status.txt"
  fi

  echo ""

  cd "$REPO_ROOT"

done < <(find . -maxdepth 4 -path "*/onchain/aiken/aiken.toml" -type f | sort)

# Print summary
echo -e "${BLUE}========================================"
echo "Aiken Compilation Summary"
echo "========================================${NC}"
echo -e "Total examples:   $TOTAL"
echo -e "${GREEN}Passed:           $PASSED ✅${NC}"
echo -e "${RED}Failed:           $FAILED ❌${NC}"
echo ""

if [[ $FAILED -gt 0 ]]; then
  echo -e "${RED}Some examples failed compilation. Check logs in $RESULTS_DIR/${NC}"
  exit 1
else
  echo -e "${GREEN}All Aiken examples compiled successfully! 🎉${NC}"
  exit 0
fi
