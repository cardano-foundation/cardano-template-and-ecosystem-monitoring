# P1W1 — Yaci-as-service-container PoC outcome

Per the plan's Phase 1.0, this PoC must precede the rest of Phase 1 and its outcome determines whether the workflow uses a Docker service container (primary) or the collapsed-offchain-matrix fallback.

## Investigation

The plan's primary approach uses a `services:` block in offchain matrix jobs:

```yaml
services:
  yaci:
    image: bloxbean/yaci-devkit:<pinned>
    ports: [8080:8080]
```

For this to work, an actively maintained Docker image of yaci-devkit must exist with the protocol surface our examples need (Yaci API on port 8080, optional Yaci-Store, etc.).

### Docker Hub state (checked 2026-05-06)

`bloxbean/yaci-devkit` exists with these tags:

| Tag | Last pushed |
|-----|-------------|
| `latest` | 2023-06-13 |
| `0.4.0` | 2023-06-13 |
| `0.3.0` | 2023-05-02 |
| `0.0.1-alpha` | 2023-05-02 |
| `0.0.1-preview` | 2024-04-24 |
| `0.0.1-preview2` | 2024-04-25 |

Most recent tag: `0.0.1-preview2`, **April 2024 — over a year old**.

Meanwhile the npm package `@bloxbean/yaci-devkit` is the canonical, actively maintained distribution and is what the existing CI workflow uses.

### Conclusion

The Docker image is not actively maintained. Pinning Wave 1 (and the rest of the roadmap) to a 1+ year old image risks:

- Missing protocol-version support newer than the image build (Conway era handling, etc.).
- Bug fixes to the npm tool not propagating.
- A silent breakage path — when the image diverges from the npm package's behavior, our matrix passes against an outdated runtime that no real user exercises.

**Decision: adopt the fallback** (already documented in the plan as the explicit alternative). Implement the offchain CI as **matrix-on-use-case** with **one Yaci install per use case job**, all SDKs declared in that use case's manifest running sequentially against the shared Yaci.

## What this means for the rest of P1W1

- The `frameworks/<name>.yml` schema does **not** need a `service_image:` field. `setup:` steps install the framework (setup-deno, setup-java, etc.); a separate `install_yaci_once` step in the job (driven by `versions.yml`) starts the shared Yaci.
- The CI workflow has two offchain test job patterns:
  - `compile-onchain`: matrix `{use_case × onchain_framework}`, no Yaci.
  - `test-offchain`: matrix `{use_case}`, one job per use case, installs all required offchain SDKs (per manifest) and one shared Yaci, runs each SDK sequentially via the `run-framework` action, aggregates per-framework `result.json` outputs.
- This eliminates the 3× Yaci install waste documented in the plan's Context section without depending on a stale Docker image.

## Reversibility

If Bloxbean publishes a fresh, actively maintained Docker image for yaci-devkit later, switching to the service-container approach is mechanical: add `service_image:` to the framework registry schema, declare it in the relevant frameworks, replace the npm-install step with a `services:` block in the workflow. The framework registry pattern is built to accept this swap.

## Reference

- Docker Hub: https://hub.docker.com/v2/repositories/bloxbean/yaci-devkit/tags
- npm: https://www.npmjs.com/package/@bloxbean/yaci-devkit
