#!/bin/bash

# Cardano Ecosystem Off-chain Integration Test Script
# Runs all off-chain examples against Yaci DevKit

# Enable immediate exit on Ctrl+C
trap 'echo -e "\n\n${RED}❌ Tests interrupted by user${NC}"; exit 130' INT TERM

set -e

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧪 Running Off-chain Integration Tests${NC}"
echo "========================================"
echo ""

# Get repository root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

# Create results directory
RESULTS_DIR=".local-test-results"
mkdir -p "$RESULTS_DIR"

# Check if Yaci DevKit is running
echo -n "Checking Yaci DevKit... "
if nc -z localhost 8080 2>/dev/null; then
  echo -e "${GREEN}✅ Running${NC}"
else
  echo -e "${RED}❌ Not running${NC}"
  echo ""
  echo "Please start Yaci DevKit first:"
  echo "  yaci-devkit up --enable-yaci-store"
  echo ""
  exit 1
fi

# Verify Blockfrost API endpoint
echo -n "Checking Blockfrost API (port 8080)... "
if nc -z localhost 8080 2>/dev/null; then
  echo -e "${GREEN}✅ Available${NC}"
else
  echo -e "${YELLOW}⚠️  Not available (may still work)${NC}"
fi

echo ""

# Counters
CCL_TOTAL=0
CCL_PASSED=0
CCL_FAILED=0
MESH_TOTAL=0
MESH_PASSED=0
MESH_FAILED=0
EVOSDK_TOTAL=0
EVOSDK_PASSED=0
EVOSDK_FAILED=0
PYCARDANO_TOTAL=0
PYCARDANO_PASSED=0
PYCARDANO_FAILED=0

# Test CCL Java examples
echo -e "${BLUE}Testing CCL Java Examples${NC}"
echo "----------------------------------------"

if ! command -v jbang &> /dev/null; then
  echo -e "${RED}❌ JBang is not installed. Skipping CCL Java tests.${NC}"
  echo "Install: curl -Ls https://sh.jbang.dev | bash -s - app setup"
  echo ""
else
  JBANG_VERSION=$(jbang version 2>/dev/null || echo "unknown")
  echo "JBang version: $JBANG_VERSION"
  echo ""

  while IFS= read -r java_file; do
    if [[ ! -f "$java_file" ]]; then
      continue
    fi

    EXAMPLE=$(echo "$java_file" | cut -d'/' -f2)
    DIR=$(dirname "$java_file")
    FILENAME=$(basename "$java_file")

    CCL_TOTAL=$((CCL_TOTAL + 1))

    echo -e "${YELLOW}📦 [$CCL_TOTAL] Testing: $EXAMPLE${NC}"
    echo "   Path: $DIR"
    echo "   File: $FILENAME"

    # Ensure plutus.json exists
    PLUTUS_JSON="$EXAMPLE/onchain/aiken/plutus.json"
    if [[ ! -f "$PLUTUS_JSON" ]]; then
      echo -e "   ${YELLOW}⚠️  plutus.json not found, building Aiken first...${NC}"
      if [[ -f "$EXAMPLE/onchain/aiken/aiken.toml" ]]; then
        (cd "$EXAMPLE/onchain/aiken" && aiken build > /dev/null 2>&1)
        if [[ -f "$PLUTUS_JSON" ]]; then
          echo -e "   ${GREEN}✅ Built successfully${NC}"
        else
          echo -e "   ${RED}❌ Aiken build failed${NC}"
          CCL_FAILED=$((CCL_FAILED + 1))
          echo "skipped" > "$RESULTS_DIR/ccl-$EXAMPLE-status.txt"
          echo ""
          continue
        fi
      fi
    fi

    cd "$DIR"

    # Run JBang with timeout and show real-time output
    echo "   Running test (timeout: 300s, press Ctrl+C to skip)..."
    echo "   Output:"
    echo ""

    # Run with tee to show output in real-time AND save to log
    # Use --foreground with timeout to make Ctrl+C work properly
    if timeout --foreground 300 jbang "$FILENAME" 2>&1 | tee "$REPO_ROOT/$RESULTS_DIR/ccl-$EXAMPLE.log"; then
      EXIT_CODE=0
    else
      EXIT_CODE=$?
    fi

    echo ""

    cd "$REPO_ROOT"

    # Check for success based on exit code only
    # All CCL Java examples now throw AssertionError on failure
    if [[ $EXIT_CODE -eq 0 ]]; then
      CCL_PASSED=$((CCL_PASSED + 1))
      echo -e "   ${GREEN}✅ PASSED${NC}"
      echo "success" > "$RESULTS_DIR/ccl-$EXAMPLE-status.txt"
    elif [[ $EXIT_CODE -eq 124 ]]; then
      CCL_FAILED=$((CCL_FAILED + 1))
      echo -e "   ${RED}❌ TIMEOUT (>300s)${NC}"
      echo "timeout" > "$RESULTS_DIR/ccl-$EXAMPLE-status.txt"
    else
      CCL_FAILED=$((CCL_FAILED + 1))
      echo -e "   ${RED}❌ FAILED (exit code: $EXIT_CODE)${NC}"
      echo "   Last 10 lines of output:"
      tail -10 "$RESULTS_DIR/ccl-$EXAMPLE.log" | sed 's/^/   | /'
      echo "failed" > "$RESULTS_DIR/ccl-$EXAMPLE-status.txt"
    fi

    echo ""

  done < <(find . -maxdepth 4 -path "*/offchain/ccl-java/*.java" -type f | sort)
fi

# Test Mesh.js examples
echo ""
echo -e "${BLUE}Testing Mesh.js Examples${NC}"
echo "----------------------------------------"

if ! command -v deno &> /dev/null; then
  echo -e "${RED}❌ Deno is not installed. Skipping Mesh.js tests.${NC}"
  echo "Install: curl -fsSL https://deno.land/install.sh | sh"
  echo ""
else
  DENO_VERSION=$(deno --version | head -1)
  echo "Deno version: $DENO_VERSION"
  echo ""

  while IFS= read -r deno_json; do
    if [[ ! -f "$deno_json" ]]; then
      continue
    fi

    DIR=$(dirname "$deno_json")
    EXAMPLE=$(echo "$DIR" | cut -d'/' -f2)

    MESH_TOTAL=$((MESH_TOTAL + 1))

    echo -e "${YELLOW}📦 [$MESH_TOTAL] Testing: $EXAMPLE${NC}"
    echo "   Path: $DIR"

    # Find TypeScript file
    TS_FILE=$(find "$DIR" -maxdepth 1 -name "*.ts" -type f | head -1)
    if [[ -z "$TS_FILE" ]]; then
      echo -e "   ${RED}❌ No TypeScript file found${NC}"
      MESH_FAILED=$((MESH_FAILED + 1))
      echo "skipped" > "$RESULTS_DIR/mesh-$EXAMPLE-status.txt"
      echo ""
      continue
    fi

    TS_FILENAME=$(basename "$TS_FILE")
    echo "   File: $TS_FILENAME"

    # Ensure plutus.json exists
    PLUTUS_JSON="$EXAMPLE/onchain/aiken/plutus.json"
    if [[ ! -f "$PLUTUS_JSON" ]]; then
      echo -e "   ${YELLOW}⚠️  plutus.json not found, building Aiken first...${NC}"
      if [[ -f "$EXAMPLE/onchain/aiken/aiken.toml" ]]; then
        (cd "$EXAMPLE/onchain/aiken" && aiken build > /dev/null 2>&1)
        if [[ -f "$PLUTUS_JSON" ]]; then
          echo -e "   ${GREEN}✅ Built successfully${NC}"
        fi
      fi
    fi

    cd "$DIR"

    # Run Deno with timeout and show real-time output
    echo "   Running test (timeout: 300s, press Ctrl+C to skip)..."
    echo "   Output:"
    echo ""

    # Run with tee to show output in real-time AND save to log
    # Use --foreground with timeout to make Ctrl+C work properly
    if timeout --foreground 300 deno run --allow-all "$TS_FILENAME" 2>&1 | tee "$REPO_ROOT/$RESULTS_DIR/mesh-$EXAMPLE.log"; then
      EXIT_CODE=0
    else
      EXIT_CODE=$?
    fi

    echo ""

    cd "$REPO_ROOT"

    # Check for success
    if [[ $EXIT_CODE -eq 0 ]]; then
      MESH_PASSED=$((MESH_PASSED + 1))
      echo -e "   ${GREEN}✅ PASSED${NC}"
      echo "success" > "$RESULTS_DIR/mesh-$EXAMPLE-status.txt"
    elif [[ $EXIT_CODE -eq 124 ]]; then
      MESH_FAILED=$((MESH_FAILED + 1))
      echo -e "   ${RED}❌ TIMEOUT (>300s)${NC}"
      echo "timeout" > "$RESULTS_DIR/mesh-$EXAMPLE-status.txt"
    else
      MESH_FAILED=$((MESH_FAILED + 1))
      echo -e "   ${RED}❌ FAILED (exit code: $EXIT_CODE)${NC}"
      echo "   Last 10 lines of output:"
      tail -10 "$RESULTS_DIR/mesh-$EXAMPLE.log" | sed 's/^/   | /'
      echo "failed" > "$RESULTS_DIR/mesh-$EXAMPLE-status.txt"
    fi

    echo ""

  done < <(find . -maxdepth 4 -path "*/offchain/meshjs/deno.json" -type f | sort)
fi

# Test Evolution SDK examples
echo ""
echo -e "${BLUE}Testing Evolution SDK Examples${NC}"
echo "----------------------------------------"

if ! command -v deno &> /dev/null; then
  echo -e "${RED}❌ Deno is not installed. Skipping Evolution SDK tests.${NC}"
else
  while IFS= read -r deno_json; do
    if [[ ! -f "$deno_json" ]]; then
      continue
    fi

    DIR=$(dirname "$deno_json")
    EXAMPLE=$(echo "$DIR" | cut -d'/' -f2)

    EVOSDK_TOTAL=$((EVOSDK_TOTAL + 1))

    echo -e "${YELLOW}📦 [$EVOSDK_TOTAL] Testing: $EXAMPLE${NC}"
    echo "   Path: $DIR"

    # Find TypeScript file
    TS_FILE=$(find "$DIR" -maxdepth 1 -name "*.ts" -type f | head -1)
    if [[ -z "$TS_FILE" ]]; then
      echo -e "   ${RED}❌ No TypeScript file found${NC}"
      EVOSDK_FAILED=$((EVOSDK_FAILED + 1))
      echo "skipped" > "$RESULTS_DIR/evosdk-$EXAMPLE-status.txt"
      echo ""
      continue
    fi

    TS_FILENAME=$(basename "$TS_FILE")
    echo "   File: $TS_FILENAME"

    # Ensure plutus.json exists
    PLUTUS_JSON="$EXAMPLE/onchain/aiken/plutus.json"
    if [[ ! -f "$PLUTUS_JSON" ]]; then
      echo -e "   ${YELLOW}⚠️  plutus.json not found, building Aiken first...${NC}"
      if [[ -f "$EXAMPLE/onchain/aiken/aiken.toml" ]]; then
        (cd "$EXAMPLE/onchain/aiken" && aiken build > /dev/null 2>&1)
      fi
    fi

    cd "$DIR"

    # Run Deno with timeout and show real-time output
    echo "   Running test (timeout: 300s, press Ctrl+C to skip)..."
    echo "   Output:"
    echo ""

    # Run with tee to show output in real-time AND save to log
    # Use --foreground with timeout to make Ctrl+C work properly
    if timeout --foreground 300 deno run --allow-all "$TS_FILENAME" 2>&1 | tee "$REPO_ROOT/$RESULTS_DIR/evosdk-$EXAMPLE.log"; then
      EXIT_CODE=0
    else
      EXIT_CODE=$?
    fi

    echo ""

    cd "$REPO_ROOT"

    # Check for success
    if [[ $EXIT_CODE -eq 0 ]]; then
      EVOSDK_PASSED=$((EVOSDK_PASSED + 1))
      echo -e "   ${GREEN}✅ PASSED${NC}"
      echo "success" > "$RESULTS_DIR/evosdk-$EXAMPLE-status.txt"
    elif [[ $EXIT_CODE -eq 124 ]]; then
      EVOSDK_FAILED=$((EVOSDK_FAILED + 1))
      echo -e "   ${RED}❌ TIMEOUT (>300s)${NC}"
      echo "timeout" > "$RESULTS_DIR/evosdk-$EXAMPLE-status.txt"
    else
      EVOSDK_FAILED=$((EVOSDK_FAILED + 1))
      echo -e "   ${RED}❌ FAILED (exit code: $EXIT_CODE)${NC}"
      echo "   Last 10 lines of output:"
      tail -10 "$RESULTS_DIR/evosdk-$EXAMPLE.log" | sed 's/^/   | /'
      echo "failed" > "$RESULTS_DIR/evosdk-$EXAMPLE-status.txt"
    fi

    echo ""

  done < <(find . -maxdepth 4 -path "*/offchain/evolutionsdk/deno.json" -type f | sort)
fi

# Test PyCardano examples
echo ""
echo -e "${BLUE}Testing PyCardano Examples${NC}"
echo "----------------------------------------"

if ! command -v python3 &> /dev/null; then
  echo -e "${RED}❌ Python is not installed. Skipping PyCardano tests.${NC}"
else
  PY_VERSION=$(python3 --version 2>&1)
  echo "Python version: $PY_VERSION"
  echo ""

  while IFS= read -r req_file; do
    if [[ ! -f "$req_file" ]]; then
      continue
    fi

    DIR=$(dirname "$req_file")
    EXAMPLE=$(echo "$DIR" | cut -d'/' -f2)

    PYCARDANO_TOTAL=$((PYCARDANO_TOTAL + 1))

    echo -e "${YELLOW}📦 [$PYCARDANO_TOTAL] Testing: $EXAMPLE${NC}"
    echo "   Path: $DIR"

    PY_FILE=$(find "$DIR" -maxdepth 1 -name "*.py" -type f | head -1)
    if [[ -z "$PY_FILE" ]]; then
      echo -e "   ${RED}❌ No Python file found${NC}"
      PYCARDANO_FAILED=$((PYCARDANO_FAILED + 1))
      echo "skipped" > "$RESULTS_DIR/pycardano-$EXAMPLE-status.txt"
      echo ""
      continue
    fi

    PY_FILENAME=$(basename "$PY_FILE")
    echo "   File: $PY_FILENAME"

    PLUTUS_JSON="$EXAMPLE/onchain/aiken/plutus.json"
    if [[ ! -f "$PLUTUS_JSON" ]]; then
      echo -e "   ${YELLOW}⚠️  plutus.json not found, building Aiken first...${NC}"
      if [[ -f "$EXAMPLE/onchain/aiken/aiken.toml" ]]; then
        (cd "$EXAMPLE/onchain/aiken" && aiken build > /dev/null 2>&1)
      fi
    fi

    VENV_DIR="$DIR/.venv-local"
    if [[ ! -d "$VENV_DIR" ]]; then
      python3 -m venv "$VENV_DIR"
    fi
    # shellcheck source=/dev/null
    source "$VENV_DIR/bin/activate"
    pip install --quiet --upgrade pip
    pip install --quiet -r "$req_file"

    cd "$DIR"
    echo "   Running test (timeout: 300s, press Ctrl+C to skip)..."
    echo "   Output:"
    echo ""

    if timeout --foreground 300 python "$PY_FILENAME" 2>&1 | tee "$REPO_ROOT/$RESULTS_DIR/pycardano-$EXAMPLE.log"; then
      EXIT_CODE=0
    else
      EXIT_CODE=$?
    fi
    echo ""
    deactivate
    cd "$REPO_ROOT"

    if [[ $EXIT_CODE -eq 0 ]]; then
      PYCARDANO_PASSED=$((PYCARDANO_PASSED + 1))
      echo -e "   ${GREEN}✅ PASSED${NC}"
      echo "success" > "$RESULTS_DIR/pycardano-$EXAMPLE-status.txt"
    elif [[ $EXIT_CODE -eq 124 ]]; then
      PYCARDANO_FAILED=$((PYCARDANO_FAILED + 1))
      echo -e "   ${RED}❌ TIMEOUT (>300s)${NC}"
      echo "timeout" > "$RESULTS_DIR/pycardano-$EXAMPLE-status.txt"
    else
      PYCARDANO_FAILED=$((PYCARDANO_FAILED + 1))
      echo -e "   ${RED}❌ FAILED (exit code: $EXIT_CODE)${NC}"
      echo "   Last 10 lines of output:"
      tail -10 "$RESULTS_DIR/pycardano-$EXAMPLE.log" | sed 's/^/   | /'
      echo "failed" > "$RESULTS_DIR/pycardano-$EXAMPLE-status.txt"
    fi

    echo ""

  done < <(find . -maxdepth 4 -path "*/offchain/pycardano/requirements.txt" -type f | sort)
fi

# Print summary
echo -e "${BLUE}========================================"
echo "Off-chain Test Summary"
echo "========================================${NC}"

if [[ $CCL_TOTAL -gt 0 ]]; then
  echo "CCL Java:"
  echo "  Total:   $CCL_TOTAL"
  echo -e "  ${GREEN}Passed:  $CCL_PASSED ✅${NC}"
  echo -e "  ${RED}Failed:  $CCL_FAILED ❌${NC}"
  echo ""
fi

if [[ $MESH_TOTAL -gt 0 ]]; then
  echo "Mesh.js:"
  echo "  Total:   $MESH_TOTAL"
  echo -e "  ${GREEN}Passed:  $MESH_PASSED ✅${NC}"
  echo -e "  ${RED}Failed:  $MESH_FAILED ❌${NC}"
  echo ""
fi

if [[ $EVOSDK_TOTAL -gt 0 ]]; then
  echo "Evolution SDK:"
  echo "  Total:   $EVOSDK_TOTAL"
  echo -e "  ${GREEN}Passed:  $EVOSDK_PASSED ✅${NC}"
  echo -e "  ${RED}Failed:  $EVOSDK_FAILED ❌${NC}"
  echo ""
fi

if [[ $PYCARDANO_TOTAL -gt 0 ]]; then
  echo "PyCardano:"
  echo "  Total:   $PYCARDANO_TOTAL"
  echo -e "  ${GREEN}Passed:  $PYCARDANO_PASSED ✅${NC}"
  echo -e "  ${RED}Failed:  $PYCARDANO_FAILED ❌${NC}"
  echo ""
fi

TOTAL_FAILED=$((CCL_FAILED + MESH_FAILED + EVOSDK_FAILED + PYCARDANO_FAILED))

if [[ $TOTAL_FAILED -gt 0 ]]; then
  echo -e "${RED}Some tests failed. Check logs in $RESULTS_DIR/${NC}"
  exit 1
else
  echo -e "${GREEN}All off-chain tests passed! 🎉${NC}"
  exit 0
fi
