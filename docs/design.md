# Design decisions

The four design decisions behind the repo's structure. Each is short on purpose; the rationale here lets a future contributor know what to keep and what is fair game to change.

## 1. The three-tier model

The repo carries three distinct kinds of artifact:

| Tier | Where | Audience |
|------|-------|----------|
| **Tier 1 — Protocol primitives** | `conformance/primitives/<category>/<name>/` (added in Phase 2) | SDK authors; ecosystem watchers; "is this SDK Cardano-X-ready" claims |
| **Tier 2 — Use-case conformance scenarios** | `<use-case>/conformance/scenarios/<era>/*.json` (added in Phase 3) | Developers who want a use case "exhaustively tested" |
| **Tier 3 — Use-case examples** | `<use-case>/onchain/<lang>/`, `<use-case>/offchain/<sdk>/` | First-time Cardano developers; learners |

Every tier is first-class. The dashboard renders all three. The use-case examples are NOT demoted to "just smoke tests" — they are the educational front door. Tier 1 (when it ships) provides a more focused hardfork-readiness signal precisely because it tests one protocol primitive at a time.

## 2. The framework registry

Adding a new offchain SDK or onchain language must be a one-PR change adding one file under [`frameworks/`](../frameworks/). The CI workflow's discovery step enumerates `frameworks/*.yml`; manifests in each use case reference frameworks by their `manifest_key`; the runner script reads the descriptor at runtime to know how to install the SDK and run a cell.

This means:

- The CI workflow doesn't hard-code SDK names.
- The discovery script doesn't hard-code SDK names.
- The aggregator and renderer don't hard-code SDK names.
- A new SDK shipped in a single PR is automatically wired into the matrix.

The current pilot exception: onchain languages still need a sibling `compile-<framework>` job in the workflow because their setup commands and output artifacts vary too much for a generic step. See [`frameworks/SCHEMA.md`](../frameworks/SCHEMA.md) "Limitations" for the details and the path to closing the gap.

## 3. Era-tagged scenarios

Conformance scenarios (Tiers 1 and 2) are tagged with the Cardano protocol era they target — `<use-case>/conformance/scenarios/<era>/*.json`, `conformance/primitives/<id>/scenarios/<era>/*.json`. When a hardfork lands, the new era is a sibling folder, not a diff. This gives "is X ready for the next era" a literal, auditable answer: the era folder either has scenarios or it doesn't, and they either pass or they don't.

For Phase 1 the only era is `conway`. The pattern is established now so future eras drop in mechanically.

## 4. The result-json runner contract

Every test cell — Tier 1, 2, or 3 — emits a JSON file describing whether it passed and why. The aggregator merges those into a single `matrix.json` per CI run. Schema:

```json
{
  "tier": "primitive | use-case-scenario | use-case-example",
  "id": "<unique cell id>",
  "use_case": "<use case>",
  "framework": "<framework>",
  "era": "conway",
  "status": "pass | fail | skipped",
  "duration_ms": 1234,
  "error_summary": "...",
  "observed": "...",
  "expected": "..."
}
```

Examples that exit non-zero without writing their own `result.json` get a synthetic one from the runner (status `pass`/`fail` derived from exit code). Examples that author their own `result.json` are trusted verbatim — that's how Tier 1/2 conformance tests carry observed-vs-expected detail.

The aggregator validates the schema on read; cells with missing or invalid fields surface as `fail` cells with `error_summary: "schema violation: …"` rather than being silently dropped or weakly defaulted. This catches bugs in the runner contract instead of hiding them.

## What is NOT load-bearing

Some choices in the repo are conventions, not principles:

- **Yaci DevKit as the test runtime.** Picked because it's actively maintained and provides a Blockfrost-compatible API at `localhost:8080/api/v1/` plus pre-funded test wallets. Could be swapped for a different local Cardano testing tool if Yaci goes away.
- **The well-known Yaci mnemonic** (`test test test ... sauce`). A property of Yaci's default genesis; not a design choice of this repo.
- **GitHub Actions for CI.** The discovery + runner + aggregator + renderer are all standalone shell/Python scripts that work outside Actions. Migrating to a different CI is a workflow rewrite, not a structural change.

## When to revise this document

Revise here when:

- A new tier is introduced (or one is removed/merged).
- The framework registry's `frameworks/<name>.yml` schema gains or loses required fields.
- The era-tagging convention changes (e.g. moving from path to a JSON field).
- The result-json schema gains new required fields.

For all of these: this document is updated alongside the change, not after. A change that violates one of these decisions without updating this document is a missing reviewer signoff.
