# How to add a conformance scenario

This guide covers two cases:

- **Tier 1 — primitive scenario** (added to `conformance/primitives/<id>/scenarios/<era>/`). One protocol-feature behaviour, exercised in isolation. Lands in P2W1 (encoding), P2W2 (tx-building, plutus-eval), and follow-ons (governance).
- **Tier 2 — use-case integration scenario** (added to `<use-case>/conformance/scenarios/<era>/`). One end-to-end contract behaviour. Lands in P3 — see the milestone scope in the planning doc.

Both share a JSON shape (era-tagged path, `id`, `description`, `input`, `expected`) and an adapter contract (read JSON → call SDK → compare → write `result.json`). Tier 1 is documented in [`../../frameworks/SCHEMA.md`](../../frameworks/SCHEMA.md) "Primitive scenario JSON"; Tier 2 use-case scenarios get the same treatment when P3 lands.

## Adding a primitive scenario (Tier 1)

### 1. Pick the right primitive

Look at [`../../conformance/taxonomy.md`](../../conformance/taxonomy.md). If your scenario tests a feature the taxonomy already covers (e.g. another datum-CBOR shape), drop it under the existing primitive. If it's a new feature, add a new primitive directory first (see "Adding a new primitive" below).

### 2. Author the scenario JSON

```sh
cd conformance/primitives/encoding/datum-cbor-roundtrip/scenarios/conway
$EDITOR my-new-scenario.json
```

Required fields (see [`../../frameworks/SCHEMA.md`](../../frameworks/SCHEMA.md) for the full schema):

```json
{
  "id":          "encoding/datum-cbor-roundtrip/conway/my-new-scenario",
  "primitive":   "encoding/datum-cbor-roundtrip",
  "era":         "conway",
  "description": "What this scenario tests, in plain English. Read by humans on the dashboard.",
  "input":       { "...": "primitive-specific" },
  "expected":    { "...": "primitive-specific" }
}
```

The `expected` values must be the **canonical** form. For CBOR-emitting primitives you can derive expected values using a reference implementation (the per-primitive READMEs link to one).

### 3. Run the scenario locally

```sh
yaci-devkit up --enable-yaci-store         # only needed for primitives with needs_yaci: true
scripts/run-conformance.sh encoding/datum-cbor-roundtrip
```

Or run a single (scenario × adapter) pair directly:

```sh
mkdir -p /tmp/run && cd /tmp/run
"$REPO_ROOT/conformance/adapters/meshjs/run-primitive.sh" \
  "$REPO_ROOT/conformance/primitives/encoding/datum-cbor-roundtrip/scenarios/conway/my-new-scenario.json"
cat result.json
```

A scenario that passes against the canonical expected values means every adapter that supports that primitive agrees with the reference. A scenario that fails means either (a) your expected values are wrong, or (b) an SDK regressed — in either case the failure is interpretable.

### 4. Verify each adapter handles it

The adapter dispatcher under `conformance/adapters/<sdk>/src/primitive-impls/` (or `primitive_impls/` for ccl-java) must have an impl for the primitive. If it doesn't, the cell reports as `skipped` (not `fail`) — coverage growth is tracked.

## Adding a new primitive (whole new behavior)

1. Pick a category under `conformance/primitives/`. Today: `encoding/`. Add a new category if needed.
2. Create the directory: `conformance/primitives/<category>/<name>/`.
3. Write a teaching-grade `README.md` following the template used by the existing encoding primitives (what / why / spec / scenarios / try-it / spec-references).
4. Add at least one scenario under `scenarios/conway/`.
5. Add an entry under [`../../conformance/taxonomy.md`](../../conformance/taxonomy.md).
6. Implement the primitive in each registered offchain adapter (under `conformance/adapters/<sdk>/src/primitive-impls/`).

## Adding a use-case scenario (Tier 2)

Lands in P3; this section will be filled in when that milestone ships. The shape is parallel to Tier 1 but the runner spins up Yaci, sets up wallets per the scenario, exercises the contract end-to-end, and asserts on observable state.
