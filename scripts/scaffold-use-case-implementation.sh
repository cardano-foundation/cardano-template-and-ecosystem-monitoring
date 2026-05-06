#!/usr/bin/env bash
#
# Scaffold a new implementation of an existing use case in a registered
# framework: creates the directory under <use-case>/<onchain|offchain>/<framework>/,
# drops a stub entry file, and registers the implementation in the use case's
# example.yml manifest. Minimum-viable: a polished version with full
# templates per framework, --dry-run, and snapshot tests is planned as a
# follow-on.
#
# Usage:
#   scripts/scaffold-use-case-implementation.sh \
#       USE_CASE=<name> KIND=<offchain|onchain> FRAMEWORK=<name>
#
# Example:
#   scripts/scaffold-use-case-implementation.sh \
#       USE_CASE=lottery KIND=offchain FRAMEWORK=ccl-java

set -euo pipefail

USE_CASE=""
KIND=""
FRAMEWORK=""
for arg in "$@"; do
  case "$arg" in
    USE_CASE=*)  USE_CASE="${arg#USE_CASE=}" ;;
    KIND=*)      KIND="${arg#KIND=}" ;;
    FRAMEWORK=*) FRAMEWORK="${arg#FRAMEWORK=}" ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      echo "usage: $0 USE_CASE=<name> KIND=<offchain|onchain> FRAMEWORK=<name>" >&2
      exit 64
      ;;
  esac
done

if [[ -z "$USE_CASE" || -z "$KIND" || -z "$FRAMEWORK" ]]; then
  echo "error: USE_CASE, KIND and FRAMEWORK are all required" >&2
  echo "usage: $0 USE_CASE=<name> KIND=<offchain|onchain> FRAMEWORK=<name>" >&2
  exit 64
fi
if [[ "$KIND" != "offchain" && "$KIND" != "onchain" ]]; then
  echo "error: KIND must be 'offchain' or 'onchain'" >&2
  exit 64
fi
if [[ ! "$USE_CASE" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "error: USE_CASE must match [a-z][a-z0-9-]*" >&2
  exit 64
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

# Validate that the framework is registered.
DESCRIPTOR="frameworks/${FRAMEWORK}.yml"
if [[ ! -f "$DESCRIPTOR" ]]; then
  echo "error: framework '${FRAMEWORK}' has no descriptor at ${DESCRIPTOR}." >&2
  echo "  Run scripts/scaffold-framework.sh KIND=${KIND} NAME=${FRAMEWORK} to create one." >&2
  exit 1
fi

# Validate that the use case exists.
if [[ ! -d "$USE_CASE" ]]; then
  echo "error: use case directory '$USE_CASE' does not exist." >&2
  exit 1
fi
MANIFEST="$USE_CASE/example.yml"
if [[ ! -f "$MANIFEST" ]]; then
  echo "error: $MANIFEST does not exist. Every use case must ship a manifest." >&2
  exit 1
fi

# Read the descriptor's run.cwd_relative_to_example to know where to scaffold.
yaml_get() {
  YAML_FILE="$1" YAML_PATH="$2" python3 - <<'PY'
import os, re
target = os.environ["YAML_PATH"]
out = None
with open(os.environ["YAML_FILE"]) as fh:
    lines = fh.readlines()
stack = []
for raw in lines:
    line = raw.rstrip("\n")
    stripped = line.lstrip()
    if not stripped or stripped.startswith("#"):
        continue
    indent = len(line) - len(stripped)
    m = re.match(r'([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$', stripped)
    if not m:
        continue
    key, val = m.group(1), m.group(2)
    if val and not val.startswith('"'):
        val = re.sub(r'\s+#.*$', '', val)
    val = val.strip()
    while stack and stack[-1][0] >= indent:
        stack.pop()
    full = ".".join([k for _, k in stack] + [key])
    if val:
        if val.startswith('"') and val.endswith('"'):
            val = val[1:-1]
        if full == target:
            out = val
            break
    else:
        stack.append((indent, key))
if out is not None:
    print(out)
PY
}

DESCRIPTOR_KIND=$(yaml_get "$DESCRIPTOR" "kind")
if [[ "$DESCRIPTOR_KIND" != "$KIND" ]]; then
  echo "error: framework '${FRAMEWORK}' is registered as kind=${DESCRIPTOR_KIND}, not ${KIND}." >&2
  exit 1
fi
CWD_REL=$(yaml_get "$DESCRIPTOR" "run.cwd_relative_to_example")
if [[ -z "$CWD_REL" ]]; then
  echo "error: descriptor $DESCRIPTOR is missing run.cwd_relative_to_example." >&2
  exit 1
fi
DEFAULT_ENTRY=$(yaml_get "$DESCRIPTOR" "default_entry" || true)
MANIFEST_KEY=$(yaml_get "$DESCRIPTOR" "manifest_key" || echo "$FRAMEWORK")

TARGET_DIR="$USE_CASE/$CWD_REL"
if [[ -d "$TARGET_DIR" ]]; then
  echo "error: $TARGET_DIR already exists. Edit the existing implementation directly." >&2
  exit 1
fi

# Pick a reasonable extension for the stub entry file based on default_entry
# glob (e.g. "*.ts" → ".ts"). Falls back to ".sh".
EXT=".sh"
case "$DEFAULT_ENTRY" in
  "*.ts")    EXT=".ts" ;;
  "*.java")  EXT=".java" ;;
  "*.py")    EXT=".py" ;;
  "*.aik")   EXT=".aik" ;;
  "*.scala") EXT=".scala" ;;
esac
ENTRY_FILE="${USE_CASE}${EXT}"
case "$EXT" in
  .java)
    # Java filename must match class name; capitalize first letter.
    ENTRY_FILE="$(echo "$USE_CASE" | python3 -c "import sys; s=sys.stdin.read().strip(); print(''.join(p.capitalize() for p in s.split('-')))").java"
    ;;
esac

mkdir -p "$TARGET_DIR"
case "$EXT" in
  .ts)
    cat > "$TARGET_DIR/$ENTRY_FILE" <<EOF
// Stub implementation of ${USE_CASE} in ${FRAMEWORK}.
//
// Replace this with a real contract interaction. The CI workflow runs this
// file with no arguments via the ${FRAMEWORK} framework runner; the
// expected contract is: exit 0 on success, non-zero on failure. Optionally
// write a result.json describing observed-vs-expected (see
// docs/reference/result-json.md once it lands).

console.log("TODO: implement ${USE_CASE} in ${FRAMEWORK}");
Deno.exit(1);
EOF
    ;;
  .java)
    CLASS_NAME="${ENTRY_FILE%.java}"
    cat > "$TARGET_DIR/$ENTRY_FILE" <<EOF
///usr/bin/env jbang "\$0" "\$@" ; exit \$?
//JAVA 24+
//DEPS com.bloxbean.cardano:cardano-client-lib:0.7.0-beta2

public class ${CLASS_NAME} {
    public static void main(String[] args) {
        // TODO: implement ${USE_CASE} in ${FRAMEWORK}.
        // Throw an AssertionError on failure so the JBang launcher exits non-zero.
        throw new AssertionError("TODO: implement ${USE_CASE}");
    }
}
EOF
    ;;
  *)
    cat > "$TARGET_DIR/$ENTRY_FILE" <<EOF
#!/usr/bin/env bash
# Stub implementation of ${USE_CASE} in ${FRAMEWORK}.
echo "TODO: implement ${USE_CASE} in ${FRAMEWORK}" >&2
exit 1
EOF
    chmod +x "$TARGET_DIR/$ENTRY_FILE"
    ;;
esac

# Add the manifest entry. We append a minimal block under the appropriate
# section, taking care not to duplicate if it's already there.
if grep -q "^[[:space:]]*${MANIFEST_KEY}:" "$MANIFEST"; then
  echo "warning: $MANIFEST already has a '${MANIFEST_KEY}:' entry — left untouched." >&2
else
  python3 - "$MANIFEST" "$KIND" "$MANIFEST_KEY" "$CWD_REL" "$ENTRY_FILE" <<'PY'
import re, sys
manifest_path, kind, key, cwd_rel, entry_file = sys.argv[1:]

with open(manifest_path) as fh:
    lines = fh.readlines()

new_block = [
    f"  {key}:\n",
    f"    path: {cwd_rel}\n",
    f"    entry: {entry_file}\n",
]

# Find the kind: section ("onchain:" or "offchain:") and append.
out = []
appended = False
in_section = False
section_indent = -1
empty_section_pattern = re.compile(rf"^(\s*){re.escape(kind)}:\s*\{{\}}\s*$")
header_pattern = re.compile(rf"^(\s*){re.escape(kind)}:\s*$")

for i, line in enumerate(lines):
    m_empty = empty_section_pattern.match(line)
    if m_empty:
        # Replace `kind: {}` with `kind:\n` + new_block
        out.append(f"{m_empty.group(1)}{kind}:\n")
        out.extend(new_block)
        appended = True
        continue
    m_header = header_pattern.match(line)
    if m_header:
        out.append(line)
        in_section = True
        section_indent = len(m_header.group(1))
        continue
    if in_section:
        # End of section: a line that isn't more indented than the header.
        stripped = line.lstrip()
        if stripped and not line[:section_indent + 1].startswith(" " * (section_indent + 1)):
            # We've left the section. Insert the block before this line.
            out.extend(new_block)
            out.append(line)
            in_section = False
            appended = True
            continue
    out.append(line)

# If the file ends while we're still in the section, append at the end.
if in_section and not appended:
    out.extend(new_block)
    appended = True

# If the section header was not found at all, append a brand-new section.
if not appended:
    if not out or not out[-1].endswith("\n"):
        out.append("\n")
    out.append(f"\n{kind}:\n")
    out.extend(new_block)

with open(manifest_path, "w") as fh:
    fh.writelines(out)
PY
fi

cat <<EOF
✅ Scaffolded ${USE_CASE}/${CWD_REL}/${ENTRY_FILE} (stub) and registered it in $MANIFEST.

Next steps:

  1. Replace the TODO in $TARGET_DIR/$ENTRY_FILE with a real contract
     interaction. The CI workflow runs this file with no arguments via the
     ${FRAMEWORK} framework's run command; exit non-zero on failure.

  2. Run scripts/local-test-discovery.sh and confirm the new cell appears.

  3. Push the branch and confirm CI runs the new cell.
EOF
