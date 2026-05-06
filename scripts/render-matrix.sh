#!/usr/bin/env bash
#
# Render a matrix.json into a markdown report (per-cell pass/fail table).
# Output is written to stdout; redirect to a file or to $GITHUB_STEP_SUMMARY.
#
# Usage:
#   scripts/render-matrix.sh <matrix-json>

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <matrix-json>" >&2
  exit 64
fi

MATRIX="$1"
[[ -f "$MATRIX" ]] || { echo "::error::$MATRIX not found" >&2; exit 1; }

MATRIX="$MATRIX" python3 - <<'PY'
import collections, json, os

with open(os.environ["MATRIX"]) as fh:
    m = json.load(fh)

generated_at = m.get("generated_at", "?")
era = m.get("era", "?")
summary = m.get("summary", {})
cells = m.get("cells", [])

print(f"# Cardano ecosystem matrix — `{era}`")
print()
print(f"_Generated: {generated_at}_")
print()
print(f"**Summary**: {summary.get('pass', 0)} passed · "
      f"{summary.get('fail', 0)} failed · "
      f"{summary.get('skipped', 0)} skipped · "
      f"{summary.get('total', 0)} total")
print()

# Group cells by tier
by_tier = collections.defaultdict(list)
for cell in cells:
    by_tier[cell.get("tier", "unknown")].append(cell)

tier_order = [
    ("primitive",          "Tier 1 — Protocol primitives"),
    ("use-case-scenario",  "Tier 2 — Use-case conformance scenarios"),
    ("use-case-example",   "Tier 3 — Use-case examples"),
]

ICON = {"pass": "✅", "fail": "❌", "skipped": "🟡"}

for tier_key, tier_label in tier_order:
    tier_cells = by_tier.get(tier_key, [])
    if not tier_cells:
        continue
    print(f"## {tier_label}")
    print()
    if tier_key == "use-case-example":
        # rows = use cases, columns = framework
        use_cases = sorted({c["use_case"] for c in tier_cells if "use_case" in c})
        frameworks = sorted({c["framework"] for c in tier_cells if "framework" in c})
        # build grid
        grid = {(uc, fw): None for uc in use_cases for fw in frameworks}
        for c in tier_cells:
            uc = c.get("use_case")
            fw = c.get("framework")
            if uc and fw:
                grid[(uc, fw)] = c.get("status", "fail")
        # render
        header = "| Use case | " + " | ".join(frameworks) + " |"
        sep    = "|" + "|".join(["----"] * (len(frameworks) + 1)) + "|"
        print(header)
        print(sep)
        for uc in use_cases:
            cells_md = []
            for fw in frameworks:
                s = grid.get((uc, fw))
                cells_md.append(ICON.get(s, "⚪") if s else "⚪")
            print(f"| {uc} | " + " | ".join(cells_md) + " |")
        print()
    else:
        # primitive / scenario tiers: rows = id, columns = framework
        ids = sorted({c.get("id", "?") for c in tier_cells})
        frameworks = sorted({c.get("framework", "?") for c in tier_cells})
        grid = {(i, fw): None for i in ids for fw in frameworks}
        for c in tier_cells:
            grid[(c.get("id"), c.get("framework"))] = c.get("status", "fail")
        header = "| Scenario | " + " | ".join(frameworks) + " |"
        sep    = "|" + "|".join(["----"] * (len(frameworks) + 1)) + "|"
        print(header)
        print(sep)
        for i in ids:
            row = []
            for fw in frameworks:
                s = grid.get((i, fw))
                row.append(ICON.get(s, "⚪") if s else "⚪")
            print(f"| `{i}` | " + " | ".join(row) + " |")
        print()

# Failures detail
failures = [c for c in cells if c.get("status") == "fail"]
if failures:
    print("## Failures")
    print()
    for c in failures:
        ident = c.get("id") or f"{c.get('use_case','?')}/{c.get('framework','?')}"
        err = c.get("error_summary", "")
        print(f"- `{ident}` ({c.get('framework','?')}) — {err}")
    print()
PY
