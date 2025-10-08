#!/bin/bash

# Cardano Ecosystem Full Test Suite
# Master script to run all tests in sequence

set -e

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Cardano Ecosystem Full Test Suite                 ║"
echo "║   Automated Discovery, Build, Test & Report         ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# Get repository root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

# Get script directory
SCRIPT_DIR="$REPO_ROOT/scripts"

# Check if scripts exist
if [[ ! -d "$SCRIPT_DIR" ]]; then
  echo -e "${RED}❌ Scripts directory not found${NC}"
  exit 1
fi

# Make scripts executable
chmod +x "$SCRIPT_DIR"/*.sh

# Clean previous results
echo -e "${YELLOW}🧹 Cleaning previous results...${NC}"
rm -rf .local-test-results
mkdir -p .local-test-results
echo ""

# Step 1: Discovery
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Step 1/5: Discovering Examples${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if "$SCRIPT_DIR/local-test-discovery.sh"; then
  echo -e "${GREEN}✅ Discovery completed${NC}"
else
  echo -e "${RED}❌ Discovery failed${NC}"
  exit 1
fi

echo ""
sleep 2

# Step 2: Compile Aiken
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Step 2/5: Compiling Aiken Examples${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if "$SCRIPT_DIR/local-test-aiken.sh"; then
  echo -e "${GREEN}✅ Aiken compilation completed${NC}"
  AIKEN_SUCCESS=true
else
  echo -e "${YELLOW}⚠️  Some Aiken examples failed (continuing anyway)${NC}"
  AIKEN_SUCCESS=false
fi

echo ""
sleep 2

# Step 3: Check Yaci DevKit
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Step 3/5: Verifying Yaci DevKit${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

YACI_RUNNING=false
YACI_STARTED_BY_SCRIPT=false

# Check if Yaci DevKit is running
echo -n "Checking for Yaci DevKit on localhost:8080... "
if nc -z localhost 8080 2>/dev/null; then
  echo -e "${GREEN}✅ Running${NC}"
  YACI_RUNNING=true
else
  echo -e "${YELLOW}⚠️  Not running${NC}"
  echo ""

  # Check if yaci-devkit command is available
  if command -v yaci-devkit &> /dev/null; then
    echo "Attempting to start Yaci DevKit..."
    echo "Command: yaci-devkit up --enable-yaci-store"
    echo ""

    # Start Yaci DevKit in background
    nohup yaci-devkit up --enable-yaci-store > .local-test-results/yaci-devkit.log 2>&1 &
    YACI_PID=$!
    echo "Started with PID: $YACI_PID"
    YACI_STARTED_BY_SCRIPT=true

    # Wait for it to become available (max 150 seconds = 30 attempts * 5 seconds)
    echo -n "Waiting for Yaci DevKit to start"
    for i in {1..30}; do
      if nc -z localhost 8080 2>/dev/null; then
        echo ""
        echo -e "${GREEN}✅ Yaci DevKit started successfully${NC}"
        YACI_RUNNING=true
        break
      fi
      echo -n "."
      sleep 5
    done

    if [[ "$YACI_RUNNING" == false ]]; then
      echo ""
      echo -e "${RED}❌ Yaci DevKit failed to start after 150 seconds${NC}"
      echo "Check logs at: .local-test-results/yaci-devkit.log"
      exit 1
    fi
  else
    echo -e "${RED}❌ Yaci DevKit is not installed${NC}"
    echo ""
    echo "Install with: npm install -g @bloxbean/yaci-devkit"
    echo "Then start manually: yaci-devkit up --enable-yaci-store"
    echo ""
    exit 1
  fi
fi

echo ""
sleep 2

# Step 4: Run off-chain tests
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Step 4/5: Running Off-chain Integration Tests${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if "$SCRIPT_DIR/local-test-offchain.sh"; then
  echo -e "${GREEN}✅ Off-chain tests completed${NC}"
  OFFCHAIN_SUCCESS=true
else
  echo -e "${YELLOW}⚠️  Some off-chain tests failed${NC}"
  OFFCHAIN_SUCCESS=false
fi

echo ""
sleep 2

# Step 5: Generate report
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}Step 5/5: Generating Ecosystem Report${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if "$SCRIPT_DIR/local-test-report.sh"; then
  REPORT_SUCCESS=true
else
  REPORT_SUCCESS=false
fi

echo ""

# Cleanup: Stop Yaci DevKit if we started it
if [[ "$YACI_STARTED_BY_SCRIPT" == true ]]; then
  echo -e "${YELLOW}Stopping Yaci DevKit (started by this script)...${NC}"
  yaci-devkit down 2>/dev/null || true
  echo -e "${GREEN}✅ Yaci DevKit stopped${NC}"
  echo ""
fi

# Final summary
echo -e "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                  Final Summary                       ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

if [[ "$AIKEN_SUCCESS" == true ]]; then
  echo -e "Aiken Compilation:   ${GREEN}✅ PASSED${NC}"
else
  echo -e "Aiken Compilation:   ${RED}❌ FAILED${NC}"
fi

if [[ "$OFFCHAIN_SUCCESS" == true ]]; then
  echo -e "Off-chain Tests:     ${GREEN}✅ PASSED${NC}"
else
  echo -e "Off-chain Tests:     ${RED}❌ FAILED${NC}"
fi

if [[ "$REPORT_SUCCESS" == true ]]; then
  echo -e "Report Generation:   ${GREEN}✅ SUCCESS${NC}"
else
  echo -e "Report Generation:   ${RED}❌ FAILED${NC}"
fi

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "📊 Full report available at: .local-test-results/ecosystem-report.md"
echo "📝 All logs available in: .local-test-results/"
echo ""

# Exit with appropriate code
if [[ "$AIKEN_SUCCESS" == true && "$OFFCHAIN_SUCCESS" == true ]]; then
  echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║           🎉 All Tests Passed! 🎉                   ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
  exit 0
else
  echo -e "${RED}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║        ⚠️  Some Tests Failed - See Report  ⚠️        ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════╝${NC}"
  exit 1
fi
