# `conformance/` — protocol-primitive conformance suite

This directory hosts the **Tier 1 protocol-primitive conformance suite** described in [`docs/design.md`](../docs/design.md). It is two things at once:

- **For learners**: a textbook of small, focused lessons on how Cardano protocol features work. Each primitive directory has a tutorial-grade README with worked examples and runnable reference implementations across multiple SDKs.
- **For SDK authors and ecosystem watchers**: a hardfork-readiness signal. Each scenario asserts a single protocol-feature behaviour; failures point at exactly which protocol primitive an SDK regressed on, instead of "use case X is failing in SDK Y for unclear reasons."

## Layout

```
conformance/
├── README.md                       (this file)
├── taxonomy.md                     canonical list of primitives, grouped by category
├── primitives/
│   └── encoding/
│       ├── datum-cbor-roundtrip/
│       │   ├── README.md           teaching unit for this primitive
│       │   └── scenarios/conway/   one JSON per scenario, era-tagged
│       ├── address-bech32-roundtrip/
│       └── plutus-data-canonical-order/
└── adapters/
    ├── meshjs/                     one adapter per registered offchain SDK
    ├── lucid-evolution/
    └── ccl-java/
```

A **primitive** = one protocol feature being tested in isolation (e.g. "given this `plutus_data` shape, produce this CBOR hex"). Each primitive lives under `primitives/<category>/<name>/` with a `README.md` and one or more scenario JSONs in `scenarios/<era>/`.

A **scenario** = one concrete input → expected output pair, plus metadata. The scenario format is documented in [`../frameworks/SCHEMA.md`](../frameworks/SCHEMA.md) and exemplified by every JSON file under `primitives/.../scenarios/`.

An **adapter** = a small program in a registered offchain SDK that knows how to consume a scenario JSON, run the primitive against the SDK's APIs, and emit a `result.json` per the runner contract. Adapters dispatch on `scenario.primitive` (the primitive id) and call the SDK-specific impl.

## How to run

Locally:

```sh
# Run every primitive scenario across every SDK adapter
scripts/run-conformance.sh

# Run a single scenario for debugging
conformance/adapters/meshjs/run-primitive.sh \
    conformance/primitives/encoding/datum-cbor-roundtrip/scenarios/conway/simple-int.json
```

Each adapter writes a `result.json` to its working directory (the runner-contract format). `scripts/run-conformance.sh` collects those into `.ci-results/<scenario-id>__<framework>.result.json` so the existing `scripts/aggregate-results.sh` and `scripts/render-matrix.sh` can produce the same matrix.json + markdown report shape used by the rest of the repo.

**Status — CI integration**: P2W1 ships the conformance directory tree and the locally-runnable adapter scaffolding. A dedicated `primitives` matrix job in `.github/workflows/ecosystem-test.yml` that runs `scripts/run-conformance.sh` and merges the results into the canonical `matrix.json` is **deferred** to a follow-on iteration — adapter impls need verification against working SDK environments before the matrix is allowed to surface them on the dashboard.

## Reading order for learners

1. **[`taxonomy.md`](taxonomy.md)** — the menu. Pick a primitive that interests you.
2. **The primitive's `README.md`** — explains *what* the primitive tests, *why* it matters, and how the underlying Cardano spec defines it.
3. **A scenario JSON** — concrete input + expected output. Reading the JSON is the fastest way to internalize what the primitive enforces.
4. **One adapter's impl** for the primitive — the same logic in real SDK code. `conformance/adapters/<sdk>/src/primitive-impls/<primitive>/` is where to look.

## Adding a new primitive

See [`../docs/how-to/add-conformance-scenario.md`](../docs/how-to/add-conformance-scenario.md) for the full flow (Tier 1 primitive scenarios are documented end-to-end; Tier 2 use-case scenarios are stubbed pending P3). Briefly:

1. Pick a category under `primitives/` (or add a new one — `encoding/`, `tx-building/`, `plutus-eval/` exist; `governance/` is reserved).
2. Create the directory with a teaching-grade `README.md`.
3. Add one or more scenario JSONs under `scenarios/conway/` (era folder).
4. Add a per-SDK impl in `adapters/<sdk>/src/primitive-impls/<primitive>/`.
5. Run discovery (`scripts/run-conformance.sh`) and verify the new primitive appears in `matrix.json`.

## What NOT to expect here

- **End-to-end use-case tests**. Those live alongside each `<use-case>/` directory under `<use-case>/conformance/scenarios/<era>/` (lands in P3 — escrow pilot). Tier-1 primitives test one protocol feature; Tier-2 use-case scenarios test one contract behaviour.
- **A bespoke alternative to existing Plutus conformance work**. Where possible, primitives wrap upstream test vectors (e.g. [`IntersectMBO/plutus-conformance`](https://github.com/IntersectMBO/plutus-conformance) for plutus-eval primitives) rather than reinvent them. P2W1 (this milestone) covers encoding only — tx-building and plutus-eval land in P2W2.
