#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

CHECK_MODE=false
DRIFTED_FILES=()

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_MODE=true ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS_FILE="$REPO_ROOT/versions.json"

# ── Prerequisites ──────────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed." >&2
  exit 1
fi

if [ ! -f "$VERSIONS_FILE" ]; then
  echo "ERROR: $VERSIONS_FILE not found." >&2
  exit 1
fi

# ── Read versions ──────────────────────────────────────────────────────────────
AIKEN_COMPILER=$(jq -r '.["aiken-compiler"]' "$VERSIONS_FILE")
STDLIB_VERSION=$(jq -r '.["aiken-lang/stdlib"]' "$VERSIONS_FILE")
VODKA_VERSION=$(jq -r '.["sidan-lab/vodka"]' "$VERSIONS_FILE")
MESH_CORE=$(jq -r '.["@meshsdk/core"]' "$VERSIONS_FILE")
MESH_CORE_CSL=$(jq -r '.["@meshsdk/core-csl"]' "$VERSIONS_FILE")
MESH_COMMON=$(jq -r '.["@meshsdk/common"]' "$VERSIONS_FILE")
LUCID_VERSION=$(jq -r '.["@evolution-sdk/lucid"]' "$VERSIONS_FILE")
CCL_VERSION=$(jq -r '.["cardano-client-lib"]' "$VERSIONS_FILE")
PYCARDANO_VERSION=$(jq -r '.["pycardano"]' "$VERSIONS_FILE")

if [ "$CHECK_MODE" = true ]; then
  echo "Checking version consistency against $VERSIONS_FILE"
else
  echo "Syncing versions from $VERSIONS_FILE"
fi
echo "  aiken-compiler:        $AIKEN_COMPILER"
echo "  aiken-lang/stdlib:     $STDLIB_VERSION"
echo "  sidan-lab/vodka:       $VODKA_VERSION"
echo "  @meshsdk/core:         $MESH_CORE"
echo "  @meshsdk/core-csl:     $MESH_CORE_CSL"
echo "  @meshsdk/common:       $MESH_COMMON"
echo "  @evolution-sdk/lucid:  $LUCID_VERSION"
echo "  cardano-client-lib:    $CCL_VERSION"
echo "  pycardano:             $PYCARDANO_VERSION"
echo ""

# ── Portable in-place sed ──────────────────────────────────────────────────────
# sed_inplace FILE SCRIPT
# Works on both macOS (BSD sed) and Linux (GNU sed).
sed_inplace() {
  local file="$1"
  local script="$2"
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' -E "$script" "$file"
  else
    sed -i -E "$script" "$file"
  fi
}

# ── 1. aiken.toml files ────────────────────────────────────────────────────────
echo "=== Updating aiken.toml files ==="

while IFS= read -r -d '' toml_file; do
  # Skip files inside build/ directories (cached dependency copies)
  if [[ "$toml_file" == */build/* ]]; then
    continue
  fi

  # ── compiler field ──
  current_compiler=$(grep -E '^compiler = ' "$toml_file" | grep -oE '"[^"]+"' | tr -d '"' || true)
  if [ "$current_compiler" = "$AIKEN_COMPILER" ]; then
    echo -e "  ${YELLOW}[SKIP]${NC}    aiken-compiler already up to date in $(basename "$toml_file") ($toml_file)"
  elif [ "$CHECK_MODE" = true ]; then
    echo -e "  ${RED}[DRIFT]${NC}   aiken-compiler: has '$current_compiler', want '$AIKEN_COMPILER' in $toml_file"
    DRIFTED_FILES+=("$toml_file")
  else
    sed_inplace "$toml_file" 's|^(compiler = ")[^"]*"|\1'"${AIKEN_COMPILER}"'"|'
    echo -e "  ${GREEN}[UPDATED]${NC} aiken-compiler in $(basename "$toml_file") ($toml_file)"
  fi

  # ── aiken-lang/stdlib version ──
  if grep -q 'name = "aiken-lang/stdlib"' "$toml_file" 2>/dev/null; then
    current_stdlib=$(awk '/name = "aiken-lang\/stdlib"/{found=1} found && /^version =/{gsub(/.*version = "|".*/, ""); print; exit}' "$toml_file" || true)
    if [ "$current_stdlib" = "$STDLIB_VERSION" ]; then
      echo -e "  ${YELLOW}[SKIP]${NC}    aiken-lang/stdlib already up to date in $(basename "$toml_file") ($toml_file)"
    elif [ "$CHECK_MODE" = true ]; then
      echo -e "  ${RED}[DRIFT]${NC}   aiken-lang/stdlib: has '$current_stdlib', want '$STDLIB_VERSION' in $toml_file"
      DRIFTED_FILES+=("$toml_file")
    else
      awk -v new_ver="$STDLIB_VERSION" '
        /name = "aiken-lang\/stdlib"/ { found=1 }
        found && /^version =/ {
          sub(/"[^"]*"/, "\"" new_ver "\"")
          found=0
        }
        { print }
      ' "$toml_file" > "${toml_file}.tmp" && mv "${toml_file}.tmp" "$toml_file"
      echo -e "  ${GREEN}[UPDATED]${NC} aiken-lang/stdlib in $(basename "$toml_file") ($toml_file)"
    fi
  fi

  # ── sidan-lab/vodka version ──
  if grep -q 'name = "sidan-lab/vodka"' "$toml_file" 2>/dev/null; then
    current_vodka=$(awk '/name = "sidan-lab\/vodka"/{found=1} found && /^version =/{gsub(/.*version = "|".*/, ""); print; exit}' "$toml_file" || true)
    if [ "$current_vodka" = "$VODKA_VERSION" ]; then
      echo -e "  ${YELLOW}[SKIP]${NC}    sidan-lab/vodka already up to date in $(basename "$toml_file") ($toml_file)"
    elif [ "$CHECK_MODE" = true ]; then
      echo -e "  ${RED}[DRIFT]${NC}   sidan-lab/vodka: has '$current_vodka', want '$VODKA_VERSION' in $toml_file"
      DRIFTED_FILES+=("$toml_file")
    else
      awk -v new_ver="$VODKA_VERSION" '
        /name = "sidan-lab\/vodka"/ { found=1 }
        found && /^version =/ {
          sub(/"[^"]*"/, "\"" new_ver "\"")
          found=0
        }
        { print }
      ' "$toml_file" > "${toml_file}.tmp" && mv "${toml_file}.tmp" "$toml_file"
      echo -e "  ${GREEN}[UPDATED]${NC} sidan-lab/vodka in $(basename "$toml_file") ($toml_file)"
    fi
  fi

done < <(find "$REPO_ROOT" -name "aiken.toml" -not -path "*/build/*" -print0 | sort -z)

echo ""

# ── 1b. Aiken pin in the CI workflow ───────────────────────────────────────────
# ecosystem-test.yml pins aiken twice: env.AIKEN_VERSION, and a literal in
# compile-aiken's `with:` block (reusable-workflow inputs cannot read env).
echo "=== Updating workflow aiken pin ==="

WORKFLOW_FILE="$REPO_ROOT/.github/workflows/ecosystem-test.yml"

update_workflow_pin() {
  local key="$1"        # e.g. "AIKEN_VERSION:" or "aiken-version:"
  local target_ver="$2"

  # Only lines with a literal version (skips `aiken-version: ${{ env... }}`)
  local current_ver
  current_ver=$(grep -E "${key} *v[0-9]" "$WORKFLOW_FILE" | head -1 | sed -E "s|.*${key} *||" | tr -d '[:space:]' || true)

  if [ -z "$current_ver" ]; then
    return 0
  fi

  if [ "$current_ver" = "$target_ver" ]; then
    echo -e "  ${YELLOW}[SKIP]${NC}    ${key} already up to date in $(basename "$WORKFLOW_FILE") ($WORKFLOW_FILE)"
  elif [ "$CHECK_MODE" = true ]; then
    echo -e "  ${RED}[DRIFT]${NC}   ${key} has '$current_ver', want '$target_ver' in $WORKFLOW_FILE"
    DRIFTED_FILES+=("$WORKFLOW_FILE")
  else
    sed_inplace "$WORKFLOW_FILE" "s|(${key} *)v[0-9][^[:space:]]*|\1${target_ver}|"
    echo -e "  ${GREEN}[UPDATED]${NC} ${key} in $(basename "$WORKFLOW_FILE") ($WORKFLOW_FILE)"
  fi
}

update_workflow_pin "AIKEN_VERSION:" "$AIKEN_COMPILER"
update_workflow_pin "aiken-version:" "$AIKEN_COMPILER"

echo ""

# ── 2. Mesh.js deno.json files ─────────────────────────────────────────────────
# Updates @meshsdk/core, @meshsdk/core-csl, @meshsdk/common.
# Does NOT touch @meshsdk/core-cst (a different package, not in versions.json).
# Handles optional leading ^ in version specifiers (strips it to pin exact version).
echo "=== Updating Mesh.js deno.json files ==="

update_npm_dep() {
  local file="$1"
  local pkg="$2"       # e.g. @meshsdk/core
  local target_ver="$3"

  # Does this file even contain this package?
  if ! grep -qF "\"${pkg}\"" "$file" 2>/dev/null; then
    return 0
  fi

  # Extract current pinned version — grab everything after the last @ in the npm: specifier
  local current_ver
  current_ver=$(grep -F "\"${pkg}\"" "$file" | grep -oE 'npm:[^"]+' | sed 's/.*@//' | tr -d '^' || true)

  if [ "$current_ver" = "$target_ver" ]; then
    echo -e "  ${YELLOW}[SKIP]${NC}    ${pkg} already up to date in $(basename "$file") ($file)"
  elif [ "$CHECK_MODE" = true ]; then
    echo -e "  ${RED}[DRIFT]${NC}   ${pkg}: has '$current_ver', want '$target_ver' in $file"
    DRIFTED_FILES+=("$file")
  else
    local escaped_pkg
    escaped_pkg=$(printf '%s' "$pkg" | sed 's|[./@]|\\&|g')
    sed_inplace "$file" \
      "s|(\"${escaped_pkg}\": \"npm:${escaped_pkg}@)[^\"]*\"|\1${target_ver}\"|"
    echo -e "  ${GREEN}[UPDATED]${NC} ${pkg} in $(basename "$file") ($file)"
  fi
}

while IFS= read -r -d '' deno_file; do
  update_npm_dep "$deno_file" "@meshsdk/core"     "$MESH_CORE"
  update_npm_dep "$deno_file" "@meshsdk/core-csl" "$MESH_CORE_CSL"
  update_npm_dep "$deno_file" "@meshsdk/common"   "$MESH_COMMON"
done < <(find "$REPO_ROOT" -path "*/offchain/meshjs/deno.json" -print0 | sort -z)

echo ""

# ── 3. Evolution SDK deno.json files ──────────────────────────────────────────
echo "=== Updating Evolution SDK deno.json files ==="

while IFS= read -r -d '' deno_file; do
  update_npm_dep "$deno_file" "@evolution-sdk/lucid" "$LUCID_VERSION"
done < <(find "$REPO_ROOT" -path "*/offchain/evolutionsdk/deno.json" -print0 | sort -z)

echo ""

# ── 4. CCL Java files ──────────────────────────────────────────────────────────
echo "=== Updating CCL Java files ==="

update_ccl_dep() {
  local file="$1"
  local artifact="$2"   # e.g. cardano-client-lib
  local target_ver="$3"

  local full_coord="com.bloxbean.cardano:${artifact}"

  if ! grep -qF "$full_coord" "$file" 2>/dev/null; then
    return 0
  fi

  # Extract current version (everything after the last colon on that line)
  local current_ver
  current_ver=$(grep -F "$full_coord:" "$file" | grep -oE ':[^:[:space:]]+$' | tr -d ':' | head -1 || true)

  if [ "$current_ver" = "$target_ver" ]; then
    echo -e "  ${YELLOW}[SKIP]${NC}    ${artifact} already up to date in $(basename "$file") ($file)"
  elif [ "$CHECK_MODE" = true ]; then
    echo -e "  ${RED}[DRIFT]${NC}   ${artifact}: has '$current_ver', want '$target_ver' in $file"
    DRIFTED_FILES+=("$file")
  else
    local escaped_artifact
    escaped_artifact=$(printf '%s' "$artifact" | sed 's|[.]|\\.|g')
    sed_inplace "$file" \
      "s|(com\\.bloxbean\\.cardano:${escaped_artifact}:)[^[:space:]]*|\1${target_ver}|g"
    echo -e "  ${GREEN}[UPDATED]${NC} ${artifact} in $(basename "$file") ($file)"
  fi
}

while IFS= read -r -d '' java_file; do
  update_ccl_dep "$java_file" "cardano-client-lib"               "$CCL_VERSION"
  update_ccl_dep "$java_file" "cardano-client-backend-blockfrost" "$CCL_VERSION"
done < <(find "$REPO_ROOT" -path "*/offchain/ccl-java/*.java" -print0 | sort -z)

echo ""

# ── 5. PyCardano requirements.txt files ────────────────────────────────────────
echo "=== Updating PyCardano requirements.txt files ==="

update_pypi_dep() {
  local file="$1"
  local pkg="$2"
  local target_ver="$3"

  if ! grep -qE "^${pkg}==" "$file" 2>/dev/null; then
    return 0
  fi

  local current_ver
  current_ver=$(grep -E "^${pkg}==" "$file" | head -1 | sed -E "s|^${pkg}==||" | tr -d '[:space:]')

  if [ "$current_ver" = "$target_ver" ]; then
    echo -e "  ${YELLOW}[SKIP]${NC}    ${pkg} already up to date in $(basename "$file") ($file)"
  elif [ "$CHECK_MODE" = true ]; then
    echo -e "  ${RED}[DRIFT]${NC}   ${pkg}: has '$current_ver', want '$target_ver' in $file"
    DRIFTED_FILES+=("$file")
  else
    sed_inplace "$file" \
      "s|^(${pkg}==).*$|\1${target_ver}|"
    echo -e "  ${GREEN}[UPDATED]${NC} ${pkg} in $(basename "$file") ($file)"
  fi
}

while IFS= read -r -d '' req_file; do
  update_pypi_dep "$req_file" "pycardano" "$PYCARDANO_VERSION"
done < <(find "$REPO_ROOT" -path "*/offchain/pycardano/requirements.txt" -print0 | sort -z)

echo ""

if [ "$CHECK_MODE" = true ]; then
  DRIFT_COUNT=${#DRIFTED_FILES[@]}
  if [ "$DRIFT_COUNT" -eq 0 ]; then
    echo -e "${GREEN}All files are consistent with versions.json.${NC}"
    exit 0
  else
    # Deduplicate file list
    UNIQUE_FILES=$(printf '%s\n' "${DRIFTED_FILES[@]}" | sort -u)
    UNIQUE_COUNT=$(printf '%s\n' "$UNIQUE_FILES" | grep -c .)
    echo -e "${RED}Version drift detected in ${UNIQUE_COUNT} file(s):${NC}"
    printf '%s\n' "$UNIQUE_FILES" | while IFS= read -r f; do
      echo -e "  ${RED}✗${NC} $f"
    done
    echo ""
    echo "Run 'bash scripts/sync-versions.sh' to fix."
    exit 1
  fi
else
  echo "Done."
fi
