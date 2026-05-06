#!/usr/bin/env bash
#
# Scaffold a new framework descriptor under frameworks/<name>.yml and prompt
# the contributor to add the version to versions.yml. Minimum-viable: this
# is the "make the registry add-without-asking promise actionable" version.
# A polished version (snapshot tests, --dry-run, full template families) is
# planned as a follow-on once the registry has more frameworks.
#
# Usage:
#   scripts/scaffold-framework.sh KIND=<offchain|onchain> NAME=<name>
#
# Example:
#   scripts/scaffold-framework.sh KIND=offchain NAME=opshin

set -euo pipefail

KIND=""
NAME=""
for arg in "$@"; do
  case "$arg" in
    KIND=*) KIND="${arg#KIND=}" ;;
    NAME=*) NAME="${arg#NAME=}" ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      echo "usage: $0 KIND=<offchain|onchain> NAME=<name>" >&2
      exit 64
      ;;
  esac
done

if [[ -z "$KIND" || -z "$NAME" ]]; then
  echo "error: both KIND and NAME are required" >&2
  echo "usage: $0 KIND=<offchain|onchain> NAME=<name>" >&2
  exit 64
fi
if [[ "$KIND" != "offchain" && "$KIND" != "onchain" ]]; then
  echo "error: KIND must be 'offchain' or 'onchain' (got '$KIND')" >&2
  exit 64
fi
# Framework names: lowercase, alphanumerics, hyphens. No spaces.
if [[ ! "$NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  echo "error: NAME must match [a-z][a-z0-9-]* (got '$NAME')" >&2
  exit 64
fi

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

DESCRIPTOR="frameworks/${NAME}.yml"
if [[ -f "$DESCRIPTOR" ]]; then
  echo "error: $DESCRIPTOR already exists. Pick a different NAME or edit the file directly." >&2
  exit 1
fi

# A minimal descriptor matching frameworks/SCHEMA.md. The contributor fills
# in the setup: and run: blocks with the framework's actual install/run
# commands. Comments inside the file walk them through the schema.
mkdir -p frameworks
case "$KIND" in
  onchain)
    cat > "$DESCRIPTOR" <<EOF
# Framework descriptor: ${NAME} (onchain language)
#
# Schema reference: frameworks/SCHEMA.md
# Versions: add a \`${NAME}: "<version>"\` entry to versions.yml.

name: ${NAME}
kind: onchain
manifest_key: ${NAME}

# REPLACE THIS BLOCK with the actual install commands for ${NAME}. Each
# step is a normal GitHub Actions composite-action step. Steps may
# reference version env vars exported by .github/actions/load-versions/,
# e.g. \${{ env.${NAME^^}_VERSION }}.
setup:
  - name: TODO install ${NAME}
    shell: bash
    run: |
      echo "::error::TODO: replace this with the actual install command for ${NAME}"
      exit 1

run:
  cwd_relative_to_example: "onchain/${NAME}"
  # \$ENTRY is substituted with the entry file resolved from the manifest
  # (or default_entry, if set). Onchain compilers usually don't take an
  # entry; the command compiles the project at the cwd and emits the
  # required artifact (e.g. plutus.json for Aiken).
  command: "echo 'TODO: replace with the actual ${NAME} compile command'; exit 1"

result:
  convention: exit-code

# REMEMBER: adding a new onchain language as a CI matrix child also
# requires a sibling \`compile-${NAME}\` job in
# .github/workflows/ecosystem-test.yml that knows how to install ${NAME}
# and consume its output artifact. See frameworks/SCHEMA.md "Limitations".
EOF
    ;;
  offchain)
    cat > "$DESCRIPTOR" <<EOF
# Framework descriptor: ${NAME} (offchain SDK)
#
# Schema reference: frameworks/SCHEMA.md
# Versions: add a \`${NAME//-/_}: "<version>"\` entry to versions.yml.

name: ${NAME}
kind: offchain
manifest_key: ${NAME}

default_entry: "*"

# REPLACE THIS BLOCK with the actual install commands for ${NAME}. Each
# step is a normal GitHub Actions composite-action step. Steps may
# reference version env vars exported by .github/actions/load-versions/.
setup:
  - name: TODO install ${NAME}
    shell: bash
    run: |
      echo "::error::TODO: replace this with the actual install command for ${NAME}"
      exit 1

run:
  cwd_relative_to_example: "offchain/${NAME}"
  # \$ENTRY is substituted with the entry file resolved from the manifest
  # (or default_entry, if set).
  command: "echo 'TODO: replace with the actual ${NAME} run command for \$ENTRY'; exit 1"

result:
  convention: exit-code

# Set to \`false\` if this offchain SDK does not need Yaci DevKit (e.g. a
# pure offline encoder). Most SDKs that build/submit transactions need it.
needs_yaci: true
EOF
    ;;
esac

VERSIONS_KEY=$(echo "$NAME" | tr '-' '_')

cat <<EOF
✅ Created $DESCRIPTOR

Next steps to land this framework in CI:

  1. Replace the TODO blocks in $DESCRIPTOR with the actual install + run
     commands. Reference frameworks/SCHEMA.md for the schema. Look at the
     existing aiken.yml / meshjs.yml / lucid-evolution.yml / ccl-java.yml
     descriptors as templates.

  2. Add a pinned version to versions.yml:

        ${VERSIONS_KEY}: "<version>"

     The CI workflow exports this as ${VERSIONS_KEY^^}_VERSION via the
     load-versions composite action; reference it from the descriptor's
     setup: block as \${{ env.${VERSIONS_KEY^^}_VERSION }}.
EOF

if [[ "$KIND" == "onchain" ]]; then
  cat <<EOF

  3. Add a sibling \`compile-${NAME}\` job in
     .github/workflows/ecosystem-test.yml. Use compile-aiken as the
     template; replace the install + run commands with ${NAME}'s.

  4. Add an \`${NAME}\` entry under \`onchain:\` in any
     <use-case>/example.yml that ships an ${NAME} implementation, pointing
     at the correct path under <use-case>/onchain/${NAME}/.
EOF
else
  cat <<EOF

  3. Add an \`${NAME}\` entry under \`offchain:\` in any
     <use-case>/example.yml that ships an ${NAME} implementation, pointing
     at the correct path under <use-case>/offchain/${NAME}/ and naming the
     entry file.

     Existing offchain workflow steps already iterate every offchain
     framework declared in each use case's manifest, so no workflow YAML
     edit is required.
EOF
fi

cat <<EOF

  5. Run \`scripts/local-test-discovery.sh\` to verify the new framework
     is recognized.

  6. Push the branch and confirm a fresh column appears in the CI matrix.
EOF
