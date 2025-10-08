#!/bin/bash

# Cardano Ecosystem Report Generator
# Generates a comprehensive markdown report from test results

set -e

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get repository root
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

RESULTS_DIR=".local-test-results"
REPORT="$RESULTS_DIR/ecosystem-report.md"

if [[ ! -d "$RESULTS_DIR" ]]; then
  echo -e "${RED}❌ Results directory not found. Run tests first.${NC}"
  exit 1
fi

echo -e "${BLUE}📊 Generating Ecosystem Report${NC}"
echo "========================================"
echo ""

# Start the report
cat > "$REPORT" << 'EOF'
# 🔍 Cardano Ecosystem Test Report

Generated: $(date '+%Y-%m-%d %H:%M:%S')

EOF

# Add date
sed -i.bak "s/\$(date.*)/$(date '+%Y-%m-%d %H:%M:%S')/" "$REPORT"
rm -f "$REPORT.bak"

# Count results for each category
AIKEN_TOTAL=$(find "$RESULTS_DIR" -name "aiken-*-status.txt" -type f 2>/dev/null | wc -l | tr -d ' ')
AIKEN_PASSED=$(grep -l "success" "$RESULTS_DIR"/aiken-*-status.txt 2>/dev/null | wc -l | tr -d ' ')
AIKEN_FAILED=$((AIKEN_TOTAL - AIKEN_PASSED))

CCL_TOTAL=$(find "$RESULTS_DIR" -name "ccl-*-status.txt" -type f 2>/dev/null | wc -l | tr -d ' ')
CCL_PASSED=$(grep -l "success" "$RESULTS_DIR"/ccl-*-status.txt 2>/dev/null | wc -l | tr -d ' ')
CCL_FAILED=$((CCL_TOTAL - CCL_PASSED))

MESH_TOTAL=$(find "$RESULTS_DIR" -name "mesh-*-status.txt" -type f 2>/dev/null | wc -l | tr -d ' ')
MESH_PASSED=$(grep -l "success" "$RESULTS_DIR"/mesh-*-status.txt 2>/dev/null | wc -l | tr -d ' ')
MESH_FAILED=$((MESH_TOTAL - MESH_PASSED))

LUCID_TOTAL=$(find "$RESULTS_DIR" -name "lucid-*-status.txt" -type f 2>/dev/null | wc -l | tr -d ' ')
LUCID_PASSED=$(grep -l "success" "$RESULTS_DIR"/lucid-*-status.txt 2>/dev/null | wc -l | tr -d ' ')
LUCID_FAILED=$((LUCID_TOTAL - LUCID_PASSED))

TOTAL=$((AIKEN_TOTAL + CCL_TOTAL + MESH_TOTAL + LUCID_TOTAL))
TOTAL_PASSED=$((AIKEN_PASSED + CCL_PASSED + MESH_PASSED + LUCID_PASSED))
TOTAL_FAILED=$((AIKEN_FAILED + CCL_FAILED + MESH_FAILED + LUCID_FAILED))

# Add summary section
cat >> "$REPORT" << EOF

## Summary

- **Total Tests**: $TOTAL
- **Passed**: $TOTAL_PASSED ✅
- **Failed**: $TOTAL_FAILED ❌
- **Success Rate**: $(awk "BEGIN {printf \"%.1f\", ($TOTAL_PASSED/$TOTAL)*100}")%

EOF

# Add on-chain compilation section
cat >> "$REPORT" << 'EOF'

## On-chain Compilation

### Aiken

EOF

if [[ $AIKEN_TOTAL -gt 0 ]]; then
  echo "**Results: $AIKEN_PASSED/$AIKEN_TOTAL passed**" >> "$REPORT"
  echo "" >> "$REPORT"

  # List all Aiken examples
  for status_file in "$RESULTS_DIR"/aiken-*-status.txt; do
    if [[ -f "$status_file" ]]; then
      EXAMPLE=$(basename "$status_file" | sed 's/aiken-//; s/-status.txt//')
      STATUS=$(cat "$status_file")

      if [[ "$STATUS" == "success" ]]; then
        echo "- ✅ $EXAMPLE" >> "$REPORT"
      else
        echo "- ❌ $EXAMPLE" >> "$REPORT"

        # Add error details if available
        if [[ -f "$RESULTS_DIR/aiken-$EXAMPLE-check.log" ]]; then
          ERROR=$(tail -5 "$RESULTS_DIR/aiken-$EXAMPLE-check.log")
          if [[ -n "$ERROR" ]]; then
            echo '```' >> "$REPORT"
            echo "$ERROR" | head -5 >> "$REPORT"
            echo '```' >> "$REPORT"
          fi
        fi
      fi
    fi
  done
else
  echo "No Aiken examples found." >> "$REPORT"
fi

echo "" >> "$REPORT"

# Add off-chain tests section
cat >> "$REPORT" << 'EOF'

## Off-chain Integration Tests

### CCL Java

EOF

if [[ $CCL_TOTAL -gt 0 ]]; then
  echo "**Results: $CCL_PASSED/$CCL_TOTAL passed**" >> "$REPORT"
  echo "" >> "$REPORT"

  for status_file in "$RESULTS_DIR"/ccl-*-status.txt; do
    if [[ -f "$status_file" ]]; then
      EXAMPLE=$(basename "$status_file" | sed 's/ccl-//; s/-status.txt//')
      STATUS=$(cat "$status_file")

      if [[ "$STATUS" == "success" ]]; then
        echo "- ✅ $EXAMPLE" >> "$REPORT"
      elif [[ "$STATUS" == "timeout" ]]; then
        echo "- ❌ $EXAMPLE (Timeout after 300s)" >> "$REPORT"
      elif [[ "$STATUS" == "skipped" ]]; then
        echo "- ⏭️  $EXAMPLE (Skipped - Aiken build failed)" >> "$REPORT"
      else
        echo "- ❌ $EXAMPLE" >> "$REPORT"

        # Add error details
        if [[ -f "$RESULTS_DIR/ccl-$EXAMPLE.log" ]]; then
          ERROR=$(tail -5 "$RESULTS_DIR/ccl-$EXAMPLE.log")
          if [[ -n "$ERROR" ]]; then
            echo '```' >> "$REPORT"
            echo "$ERROR" | head -5 >> "$REPORT"
            echo '```' >> "$REPORT"
          fi
        fi
      fi
    fi
  done
else
  echo "No CCL Java examples found." >> "$REPORT"
fi

echo "" >> "$REPORT"

# Mesh.js section
cat >> "$REPORT" << 'EOF'

### Mesh.js

EOF

if [[ $MESH_TOTAL -gt 0 ]]; then
  echo "**Results: $MESH_PASSED/$MESH_TOTAL passed**" >> "$REPORT"
  echo "" >> "$REPORT"

  for status_file in "$RESULTS_DIR"/mesh-*-status.txt; do
    if [[ -f "$status_file" ]]; then
      EXAMPLE=$(basename "$status_file" | sed 's/mesh-//; s/-status.txt//')
      STATUS=$(cat "$status_file")

      if [[ "$STATUS" == "success" ]]; then
        echo "- ✅ $EXAMPLE" >> "$REPORT"
      elif [[ "$STATUS" == "timeout" ]]; then
        echo "- ❌ $EXAMPLE (Timeout after 300s)" >> "$REPORT"
      elif [[ "$STATUS" == "skipped" ]]; then
        echo "- ⏭️  $EXAMPLE (Skipped)" >> "$REPORT"
      else
        echo "- ❌ $EXAMPLE" >> "$REPORT"

        if [[ -f "$RESULTS_DIR/mesh-$EXAMPLE.log" ]]; then
          ERROR=$(tail -5 "$RESULTS_DIR/mesh-$EXAMPLE.log")
          if [[ -n "$ERROR" ]]; then
            echo '```' >> "$REPORT"
            echo "$ERROR" | head -5 >> "$REPORT"
            echo '```' >> "$REPORT"
          fi
        fi
      fi
    fi
  done
else
  echo "No Mesh.js examples found." >> "$REPORT"
fi

echo "" >> "$REPORT"

# Lucid Evolution section
cat >> "$REPORT" << 'EOF'

### Lucid Evolution

EOF

if [[ $LUCID_TOTAL -gt 0 ]]; then
  echo "**Results: $LUCID_PASSED/$LUCID_TOTAL passed**" >> "$REPORT"
  echo "" >> "$REPORT"

  for status_file in "$RESULTS_DIR"/lucid-*-status.txt; do
    if [[ -f "$status_file" ]]; then
      EXAMPLE=$(basename "$status_file" | sed 's/lucid-//; s/-status.txt//')
      STATUS=$(cat "$status_file")

      if [[ "$STATUS" == "success" ]]; then
        echo "- ✅ $EXAMPLE" >> "$REPORT"
      elif [[ "$STATUS" == "timeout" ]]; then
        echo "- ❌ $EXAMPLE (Timeout after 300s)" >> "$REPORT"
      elif [[ "$STATUS" == "skipped" ]]; then
        echo "- ⏭️  $EXAMPLE (Skipped)" >> "$REPORT"
      else
        echo "- ❌ $EXAMPLE" >> "$REPORT"
      fi
    fi
  done
else
  echo "No Lucid Evolution examples found." >> "$REPORT"
fi

echo "" >> "$REPORT"

# Generate ecosystem readiness matrix
cat >> "$REPORT" << 'EOF'

## Ecosystem Readiness Matrix

| Use Case | Aiken | Scalus | CCL | Mesh | Lucid |
|----------|-------|--------|-----|------|-------|
EOF

# Get unique list of all use cases
ALL_EXAMPLES=$(find "$RESULTS_DIR" -name "*-status.txt" -type f | while read -r f; do
  basename "$f" | sed 's/^aiken-//; s/^ccl-//; s/^mesh-//; s/^lucid-//; s/-status.txt$//'
done | sort -u)

# For each use case, check status across all frameworks
for example in $ALL_EXAMPLES; do
  # Check Aiken status
  if [[ -f "$RESULTS_DIR/aiken-$example-status.txt" ]]; then
    AIKEN_STATUS=$(cat "$RESULTS_DIR/aiken-$example-status.txt")
    [[ "$AIKEN_STATUS" == "success" ]] && AIKEN="✅" || AIKEN="❌"
  else
    AIKEN="-"
  fi

  # Check Scalus status (placeholder - not all examples have Scalus)
  SCALUS="-"

  # Check CCL status
  if [[ -f "$RESULTS_DIR/ccl-$example-status.txt" ]]; then
    CCL_STATUS=$(cat "$RESULTS_DIR/ccl-$example-status.txt")
    [[ "$CCL_STATUS" == "success" ]] && CCL="✅" || CCL="❌"
  else
    CCL="-"
  fi

  # Check Mesh status
  if [[ -f "$RESULTS_DIR/mesh-$example-status.txt" ]]; then
    MESH_STATUS=$(cat "$RESULTS_DIR/mesh-$example-status.txt")
    [[ "$MESH_STATUS" == "success" ]] && MESH="✅" || MESH="❌"
  else
    MESH="-"
  fi

  # Check Lucid status
  if [[ -f "$RESULTS_DIR/lucid-$example-status.txt" ]]; then
    LUCID_STATUS=$(cat "$RESULTS_DIR/lucid-$example-status.txt")
    [[ "$LUCID_STATUS" == "success" ]] && LUCID="✅" || LUCID="❌"
  else
    LUCID="-"
  fi

  echo "| $example | $AIKEN | $SCALUS | $CCL | $MESH | $LUCID |" >> "$REPORT"
done

# Add footer
cat >> "$REPORT" << 'EOF'

---

## Notes

- ✅ = Test passed
- ❌ = Test failed
- ⏭️  = Test skipped
- \- = Not implemented

## Logs

All test logs are available in `.local-test-results/` directory.

EOF

# Display report
echo -e "${GREEN}✅ Report generated: $REPORT${NC}"
echo ""
echo "========================================"
cat "$REPORT"
echo "========================================"
echo ""

# Summary output
if [[ $TOTAL_FAILED -gt 0 ]]; then
  echo -e "${RED}⚠️  $TOTAL_FAILED test(s) failed${NC}"
  exit 1
else
  echo -e "${GREEN}✅ All tests passed!${NC}"
  exit 0
fi
