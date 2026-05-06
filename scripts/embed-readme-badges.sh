#!/usr/bin/env bash
#
# Embed CI status badges in every use case's README.md and at the top-level
# README.md. Idempotent: re-running the script is safe — it skips READMEs
# that already have the badge marker.
#
# **Limitation**: today every embedded badge points at the SAME thing — the
# overall pass/fail of the ecosystem-test.yml workflow on the default
# branch. The per-use-case README badge does NOT yet reflect that specific
# use case's status; it reflects the whole repo's last green run.
#
# This is a known interim. Per-use-case (and per-cell) badges driven by
# matrix.json land alongside the public dashboard, where shields.io
# endpoint badges can pull from a JSON fed by the dashboard deploy. The
# CI_BADGE_BLOCK_BEGIN/END marker comments make that future migration a
# sed replacement.

set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$REPO_ROOT"

# Resolve org/repo from the origin URL. Fall back to a placeholder if the
# remote isn't a GitHub URL (for safety in detached environments).
ORG_REPO=""
ORIGIN=$(git remote get-url origin 2>/dev/null || echo "")
if [[ "$ORIGIN" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
  ORG_REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
else
  echo "warning: could not infer org/repo from origin URL '$ORIGIN'; using placeholder" >&2
  ORG_REPO="cardano-foundation/cardano-template-and-ecosystem-monitoring"
fi

WORKFLOW_BADGE="https://github.com/${ORG_REPO}/actions/workflows/ecosystem-test.yml/badge.svg?branch=main"
WORKFLOW_LINK="https://github.com/${ORG_REPO}/actions/workflows/ecosystem-test.yml"

readonly BEGIN="<!-- CI_BADGE_BLOCK_BEGIN -->"
readonly END="<!-- CI_BADGE_BLOCK_END -->"

embed_in_readme() {
  local readme="$1"
  local label="$2"
  if [[ ! -f "$readme" ]]; then
    return
  fi
  if grep -qF "$BEGIN" "$readme"; then
    echo "  skip $readme — badge block already present"
    return
  fi

  # Insert the badge block immediately after the first heading (H1 or H2,
  # whichever comes first). If no heading is found, insert at the top.
  python3 - "$readme" "$label" <<PY
import re, sys
path, label = sys.argv[1], sys.argv[2]
with open(path) as fh:
    lines = fh.readlines()
block = [
    f'$BEGIN\n',
    f'[![{label}]($WORKFLOW_BADGE)]($WORKFLOW_LINK)\n',
    f'$END\n',
    '\n',
]
inserted = False
out = []
for i, line in enumerate(lines):
    out.append(line)
    if not inserted and re.match(r'^#{1,2}\s', line):
        # Skip any blank line right after the heading, then insert.
        if i + 1 < len(lines) and lines[i + 1].strip() == '':
            out.append(lines[i + 1])
            # Replace the index pointer by mutating the original list copy
            # (we'll just dedupe at the end via a simple guard below).
            pass
        out.extend(block)
        inserted = True
        continue
if not inserted:
    out = block + out
with open(path, "w") as fh:
    fh.writelines(out)
print(f"  embed {path}")
PY
}

# Top-level README
embed_in_readme "README.md" "Cardano ecosystem tests"

# Per-use-case READMEs
for uc_dir in */; do
  uc="${uc_dir%/}"
  [[ -f "$uc/README.md" ]] || continue
  # Only treat directories that look like use cases (have onchain or
  # offchain dirs OR a manifest declaring them).
  if [[ -f "$uc/example.yml" || -d "$uc/onchain" || -d "$uc/offchain" ]]; then
    embed_in_readme "$uc/README.md" "Ecosystem tests · $uc"
  fi
done

echo
echo "Done. Re-run anytime; the script is idempotent."
