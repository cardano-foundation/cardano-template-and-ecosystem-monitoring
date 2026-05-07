#!/bin/bash
set -e

# Cardano Ecosystem – Library Version Checker
# Queries upstream sources for the latest version of each pinned library,
# compares against versions.json, and reports drift.

# ── Colors ─────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ── Paths ───────────────────────────────────────────────────────────────────────
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSIONS_FILE="$REPO_ROOT/versions.json"
RESULTS_DIR="$REPO_ROOT/.local-test-results"

mkdir -p "$RESULTS_DIR"

# ── Prerequisites ───────────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed." >&2
  exit 1
fi

if [ ! -f "$VERSIONS_FILE" ]; then
  echo "ERROR: $VERSIONS_FILE not found." >&2
  exit 1
fi

# ── Read pinned versions ────────────────────────────────────────────────────────
PINNED_AIKEN_COMPILER=$(jq -r '.["aiken-compiler"]'       "$VERSIONS_FILE")
PINNED_STDLIB=$(jq -r '.["aiken-lang/stdlib"]'            "$VERSIONS_FILE")
PINNED_VODKA=$(jq -r '.["sidan-lab/vodka"]'               "$VERSIONS_FILE")
PINNED_MESH_CORE=$(jq -r '.["@meshsdk/core"]'             "$VERSIONS_FILE")
PINNED_MESH_CORE_CSL=$(jq -r '.["@meshsdk/core-csl"]'     "$VERSIONS_FILE")
PINNED_MESH_COMMON=$(jq -r '.["@meshsdk/common"]'         "$VERSIONS_FILE")
PINNED_LUCID=$(jq -r '.["@evolution-sdk/lucid"]'          "$VERSIONS_FILE")
PINNED_CCL=$(jq -r '.["cardano-client-lib"]'              "$VERSIONS_FILE")

echo -e "${BLUE}Checking upstream versions against $VERSIONS_FILE${NC}"
echo ""

# ── GitHub API helper ───────────────────────────────────────────────────────────
# Usage: fetch_github_latest <owner/repo>
# Prints the latest tag_name, or "unknown" on failure.
fetch_github_latest() {
  local repo="$1"
  local response
  response=$(curl -s --max-time 10 \
    -H "Accept: application/vnd.github.v3+json" \
    ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} \
    "https://api.github.com/repos/${repo}/releases/latest" 2>/dev/null) || true

  local tag
  tag=$(printf '%s' "$response" | jq -r '.tag_name // empty' 2>/dev/null) || true

  if [ -z "$tag" ] || [ "$tag" = "null" ]; then
    echo "unknown"
  else
    echo "$tag"
  fi
}

# ── npm registry helper ─────────────────────────────────────────────────────────
# Usage: fetch_npm_latest <package>
# Prints the latest version string, or "unknown" on failure.
fetch_npm_latest() {
  local pkg="$1"
  local response
  response=$(curl -s --max-time 10 \
    "https://registry.npmjs.org/${pkg}/latest" 2>/dev/null) || true

  local ver
  ver=$(printf '%s' "$response" | jq -r '.version // empty' 2>/dev/null) || true

  if [ -z "$ver" ] || [ "$ver" = "null" ]; then
    echo "unknown"
  else
    echo "$ver"
  fi
}

# ── Maven Central helper ────────────────────────────────────────────────────────
# Prints the latest version string, or "unknown" on failure.
fetch_maven_latest() {
  local response
  response=$(curl -s --max-time 10 \
    "https://search.maven.org/solrsearch/select?q=g:com.bloxbean.cardano+AND+a:cardano-client-lib&rows=1&wt=json" \
    2>/dev/null) || true

  local ver
  ver=$(printf '%s' "$response" | jq -r '.response.docs[0].latestVersion // empty' 2>/dev/null) || true

  if [ -z "$ver" ] || [ "$ver" = "null" ]; then
    echo "unknown"
  else
    echo "$ver"
  fi
}

# ── Semver bump type helper ─────────────────────────────────────────────────────
# Usage: bump_type <pinned> <latest>
# Strips leading 'v'. Returns: major | minor | patch
# Non-semver strings always return "patch".
bump_type() {
  local pinned="${1#v}"
  local latest="${2#v}"

  # Extract numeric major.minor.patch (ignore pre-release suffixes)
  local p_major p_minor p_patch l_major l_minor l_patch
  p_major=$(printf '%s' "$pinned" | grep -oE '^[0-9]+' || echo "0")
  p_minor=$(printf '%s' "$pinned" | grep -oE '^[0-9]+\.[0-9]+' | grep -oE '[0-9]+$' || echo "0")
  p_patch=$(printf '%s' "$pinned" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' | grep -oE '[0-9]+$' || echo "0")

  l_major=$(printf '%s' "$latest" | grep -oE '^[0-9]+' || echo "0")
  l_minor=$(printf '%s' "$latest" | grep -oE '^[0-9]+\.[0-9]+' | grep -oE '[0-9]+$' || echo "0")
  l_patch=$(printf '%s' "$latest" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' | grep -oE '[0-9]+$' || echo "0")

  if [ "$l_major" != "$p_major" ]; then
    echo "major"
  elif [ "$l_minor" != "$p_minor" ]; then
    echo "minor"
  else
    echo "patch"
  fi
}

# ── Fetch all upstream versions ─────────────────────────────────────────────────
echo -e "${BLUE}Fetching upstream versions...${NC}"

LATEST_AIKEN_COMPILER=$(fetch_github_latest "txpipe/aiken")
LATEST_STDLIB=$(fetch_github_latest "aiken-lang/stdlib")
LATEST_VODKA=$(fetch_github_latest "sidan-lab/vodka")
LATEST_MESH_CORE=$(fetch_npm_latest "@meshsdk/core")
LATEST_MESH_CORE_CSL=$(fetch_npm_latest "@meshsdk/core-csl")
LATEST_MESH_COMMON=$(fetch_npm_latest "@meshsdk/common")
LATEST_LUCID=$(fetch_npm_latest "@evolution-sdk/lucid")
LATEST_CCL=$(fetch_maven_latest)

echo ""

# ── Compare and build report data ───────────────────────────────────────────────
OUTDATED_COUNT=0
TOTAL_COUNT=8
HAS_MAJOR=false

# compare_entry <name> <pinned> <latest>
# Sets global ENTRY_JSON, increments OUTDATED_COUNT, sets HAS_MAJOR if needed.
compare_entry() {
  local name="$1"
  local pinned="$2"
  local latest="$3"

  local outdated="false"
  local bump="null"

  if [ "$latest" = "unknown" ]; then
    # Cannot determine – treat as up to date, no bump
    outdated="false"
    bump="null"
  elif [ "$pinned" != "$latest" ]; then
    outdated="true"
    OUTDATED_COUNT=$((OUTDATED_COUNT + 1))
    local bt
    bt=$(bump_type "$pinned" "$latest")
    bump="\"$bt\""
    if [ "$bt" = "major" ]; then
      HAS_MAJOR=true
    fi
  fi

  # Print colored line to stdout
  if [ "$latest" = "unknown" ]; then
    echo -e "  ${YELLOW}[UNKNOWN ]${NC} ${name}: ${pinned} → (could not fetch upstream)"
  elif [ "$outdated" = "true" ]; then
    echo -e "  ${RED}[OUTDATED]${NC} ${name}: ${pinned} → ${latest}  (${bump//\"/})"
  else
    echo -e "  ${GREEN}[OK      ]${NC} ${name}: ${pinned} (up to date)"
  fi

  # Build JSON fragment (stored in ENTRY_JSON for caller to collect)
  ENTRY_JSON=$(printf '"%s": {"pinned": "%s", "latest": "%s", "outdated": %s, "bumpType": %s}' \
    "$name" "$pinned" "$latest" "$outdated" "$bump")
}

echo -e "${BLUE}Comparing versions:${NC}"

compare_entry "aiken-compiler"      "$PINNED_AIKEN_COMPILER"  "$LATEST_AIKEN_COMPILER"
ENTRY_AIKEN_COMPILER="$ENTRY_JSON"

compare_entry "aiken-lang/stdlib"   "$PINNED_STDLIB"          "$LATEST_STDLIB"
ENTRY_STDLIB="$ENTRY_JSON"

compare_entry "sidan-lab/vodka"     "$PINNED_VODKA"           "$LATEST_VODKA"
ENTRY_VODKA="$ENTRY_JSON"

compare_entry "@meshsdk/core"       "$PINNED_MESH_CORE"       "$LATEST_MESH_CORE"
ENTRY_MESH_CORE="$ENTRY_JSON"

compare_entry "@meshsdk/core-csl"   "$PINNED_MESH_CORE_CSL"   "$LATEST_MESH_CORE_CSL"
ENTRY_MESH_CORE_CSL="$ENTRY_JSON"

compare_entry "@meshsdk/common"     "$PINNED_MESH_COMMON"     "$LATEST_MESH_COMMON"
ENTRY_MESH_COMMON="$ENTRY_JSON"

compare_entry "@evolution-sdk/lucid" "$PINNED_LUCID"          "$LATEST_LUCID"
ENTRY_LUCID="$ENTRY_JSON"

compare_entry "cardano-client-lib"  "$PINNED_CCL"             "$LATEST_CCL"
ENTRY_CCL="$ENTRY_JSON"

echo ""

UP_TO_DATE_COUNT=$((TOTAL_COUNT - OUTDATED_COUNT))
GENERATED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# ── Write version-report.json ───────────────────────────────────────────────────
JSON_FILE="$RESULTS_DIR/version-report.json"

cat > "$JSON_FILE" <<EOF
{
  "generatedAt": "${GENERATED_AT}",
  "libraries": {
    ${ENTRY_AIKEN_COMPILER},
    ${ENTRY_STDLIB},
    ${ENTRY_VODKA},
    ${ENTRY_MESH_CORE},
    ${ENTRY_MESH_CORE_CSL},
    ${ENTRY_MESH_COMMON},
    ${ENTRY_LUCID},
    ${ENTRY_CCL}
  },
  "summary": {
    "total": ${TOTAL_COUNT},
    "outdated": ${OUTDATED_COUNT},
    "upToDate": ${UP_TO_DATE_COUNT}
  }
}
EOF

echo -e "${GREEN}JSON report written to:${NC} $JSON_FILE"

# ── Write version-report.md ─────────────────────────────────────────────────────
MD_FILE="$RESULTS_DIR/version-report.md"

{
  echo "# Library Version Report"
  echo ""
  echo "Generated: ${GENERATED_AT}"
  echo ""
  echo "## Summary"
  echo ""
  echo "- **Total libraries**: ${TOTAL_COUNT}"
  echo "- **Up to date**: ${UP_TO_DATE_COUNT}"
  echo "- **Outdated**: ${OUTDATED_COUNT}"
  echo ""
  echo "## Details"
  echo ""
  echo "| Library | Pinned | Latest | Status | Bump |"
  echo "|---------|--------|--------|--------|------|"

  print_md_row() {
    local name="$1" pinned="$2" latest="$3"
    local status bump_label
    if [ "$latest" = "unknown" ]; then
      status="unknown"
      bump_label="-"
    elif [ "$pinned" = "$latest" ]; then
      status="up to date"
      bump_label="-"
    else
      local bt
      bt=$(bump_type "$pinned" "$latest")
      status="outdated"
      bump_label="$bt"
    fi
    printf "| %s | %s | %s | %s | %s |\n" "$name" "$pinned" "$latest" "$status" "$bump_label"
  }

  print_md_row "aiken-compiler"       "$PINNED_AIKEN_COMPILER"  "$LATEST_AIKEN_COMPILER"
  print_md_row "aiken-lang/stdlib"    "$PINNED_STDLIB"          "$LATEST_STDLIB"
  print_md_row "sidan-lab/vodka"      "$PINNED_VODKA"           "$LATEST_VODKA"
  print_md_row "@meshsdk/core"        "$PINNED_MESH_CORE"       "$LATEST_MESH_CORE"
  print_md_row "@meshsdk/core-csl"    "$PINNED_MESH_CORE_CSL"   "$LATEST_MESH_CORE_CSL"
  print_md_row "@meshsdk/common"      "$PINNED_MESH_COMMON"     "$LATEST_MESH_COMMON"
  print_md_row "@evolution-sdk/lucid" "$PINNED_LUCID"           "$LATEST_LUCID"
  print_md_row "cardano-client-lib"   "$PINNED_CCL"             "$LATEST_CCL"

  echo ""
  echo "---"
  echo "_Generated by scripts/check-library-versions.sh_"
} > "$MD_FILE"

echo -e "${GREEN}Markdown report written to:${NC} $MD_FILE"
echo ""

# ── GitHub Actions environment export ──────────────────────────────────────────
if [ -n "${GITHUB_ENV:-}" ]; then
  if [ "$OUTDATED_COUNT" -gt 0 ]; then
    echo "VERSIONS_OUTDATED=true" >> "$GITHUB_ENV"
  else
    echo "VERSIONS_OUTDATED=false" >> "$GITHUB_ENV"
  fi

  if [ "$HAS_MAJOR" = "true" ]; then
    echo "VERSION_BUMP_LABEL=major-upgrade" >> "$GITHUB_ENV"
  else
    echo "VERSION_BUMP_LABEL=minor-upgrade" >> "$GITHUB_ENV"
  fi

  echo -e "${BLUE}GitHub Actions env vars written to \$GITHUB_ENV${NC}"
  echo ""
fi

# ── Final summary ───────────────────────────────────────────────────────────────
if [ "$OUTDATED_COUNT" -gt 0 ]; then
  echo -e "${YELLOW}${OUTDATED_COUNT} of ${TOTAL_COUNT} libraries are outdated. See ${JSON_FILE} for details.${NC}"
else
  echo -e "${GREEN}All ${TOTAL_COUNT} libraries are up to date.${NC}"
fi

# Always exit 0 – never fail the CI job.
exit 0
