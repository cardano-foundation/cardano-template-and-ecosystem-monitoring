# Schemas at a glance

This is a one-page index of the file formats the repo uses for configuration and CI signal. Each schema's source of truth lives as a top-of-file comment in a canonical example or in a dedicated SCHEMA file alongside it. This page links you to the right one.

| Schema | Source of truth | Used by |
|--------|-----------------|---------|
| Tool versions | [`versions.yml`](../versions.yml) (the file IS the schema; comments inline) | All CI install steps; framework descriptors via `<KEY>_VERSION` env vars |
| Framework descriptor | [`frameworks/SCHEMA.md`](../frameworks/SCHEMA.md) plus inline comments in `frameworks/<name>.yml` | CI discovery, the cell runner, aggregator |
| Use-case manifest | [`frameworks/SCHEMA.md`](../frameworks/SCHEMA.md) "Use-case manifest" section, plus inline comments in `<use-case>/example.yml` | CI discovery, per-cell runner |
| `result.json` (test cell output) | [`design.md`](design.md) "The result-json runner contract" + inline schema in [`scripts/aggregate-results.sh`](../scripts/aggregate-results.sh) | Every test cell writes one (or has it synthesized); aggregator reads them; dashboard renders them |
| Primitive scenario JSON (Tier 1) | TBD — lands in Phase 2 | Conformance primitive runners and adapters |
| Use-case scenario JSON (Tier 2) | TBD — lands in Phase 3 | Conformance use-case scenario runners |

## Quick reference

### `versions.yml`

Flat YAML, top-level scalar key:value pairs only. Each key is a tool/library; the value is its pinned version. Keys are uppercased and suffixed with `_VERSION` when exported as env vars (`aiken: "1.1.21"` → `AIKEN_VERSION=1.1.21`). The `protocol_version` key names the Cardano era.

### `frameworks/<name>.yml`

Registers one onchain language or offchain SDK. Required fields: `name`, `kind` (`onchain`|`offchain`), `manifest_key`, `setup` (composite-action steps), `run` (`cwd_relative_to_example` + `command`), `result.convention` (`exit-code`|`result-json`). For `kind: offchain`, also `needs_yaci`. Full schema with rationale: [`frameworks/SCHEMA.md`](../frameworks/SCHEMA.md).

### `<use-case>/example.yml`

Declares which registered frameworks the use case ships. Top-level `use_case`, `description`, `onchain:` and `offchain:` mappings. Keys under `onchain:` and `offchain:` are framework `manifest_key` values from the registry; each entry has `path:` (required) and `entry:` (optional — falls back to descriptor's `default_entry` glob). Empty mappings (`onchain: {}` / `offchain: {}`) are valid and mark a use case as not-yet-implemented.

### `result.json`

Required fields: `tier`, `framework`, `status`, `duration_ms`. Tier-specific identity: `use_case` for `use-case-example`; `use_case` + `id` for `use-case-scenario`; `id` for `primitive`. Optional: `era`, `error_summary`, `observed`, `expected`. Cells that fail the schema check are surfaced as `fail` with the violation in `error_summary`.

## How to add a new schema

If you find yourself wanting to add a new file format, ask first: can the data live as a few comment lines in an existing canonical example, or as a new section of [`frameworks/SCHEMA.md`](../frameworks/SCHEMA.md)? Adding a schema means creating an index entry here and a source-of-truth document. Don't fragment.
