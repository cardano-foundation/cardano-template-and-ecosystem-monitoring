#!/bin/bash
set -e

# Cardano Ecosystem – Full Version Upgrade
# 1. Fetch latest upstream versions for every pinned library
# 2. Rewrite versions.json with those values
# 3. Propagate versions.json to every aiken.toml / deno.json / *.java

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS_FILE="$REPO_ROOT/versions.json"
REPORT_FILE="$REPO_ROOT/.local-test-results/version-report.json"

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed." >&2
  exit 1
fi

echo -e "${BLUE}== Step 1/3: fetching upstream versions ==${NC}"
bash "$REPO_ROOT/scripts/check-library-versions.sh"

if [ ! -f "$REPORT_FILE" ]; then
  echo "ERROR: $REPORT_FILE missing — version check did not produce a report." >&2
  exit 1
fi

echo ""
echo -e "${BLUE}== Step 2/3: rewriting versions.json ==${NC}"
jq '.libraries | to_entries | map({key: .key, value: .value.latest}) | from_entries' \
  "$REPORT_FILE" > "${VERSIONS_FILE}.new"
mv "${VERSIONS_FILE}.new" "$VERSIONS_FILE"
echo -e "${GREEN}versions.json updated:${NC}"
cat "$VERSIONS_FILE"

echo ""
echo -e "${BLUE}== Step 3/3: propagating to project files ==${NC}"
bash "$REPO_ROOT/scripts/sync-versions.sh"

echo ""
echo -e "${GREEN}Upgrade complete.${NC}"
echo -e "${YELLOW}Review the diff with 'git diff', then rebuild and test before committing.${NC}"
