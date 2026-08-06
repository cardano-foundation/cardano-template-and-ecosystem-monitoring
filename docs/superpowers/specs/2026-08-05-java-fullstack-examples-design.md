# Java fullstack examples + pipeline tracking — design

**Date:** 2026-08-05
**Branch:** `feat/add-java-julc-fullstack`
**Status:** approved

## Goal

Every use case in this repo gets a self-contained **Java fullstack** example under
`<use-case>/fullstack/java/` — a julc (Java → Plutus V3) on-chain validator plus a
cardano-client-lib (CCL) off-chain flow in one runnable Gradle project — and the
ecosystem pipeline tracks those examples so they appear as a first-class column
group in the dashboard.

`atomic-transaction/fullstack/java/` already exists and is the shape reference.
This work replicates it across the remaining 20 use cases and wires the result
into CI and the dashboard.

## Starting state (verified 2026-08-05)

- `atomic-transaction/fullstack/java/` — 14 files, the only real implementation. Untracked.
- Every other `*/fullstack/java/` directory — **empty placeholder**, 0 files.
- `simple-transfer/fullstack/java/` — contains only stale, gitignored Gradle build
  output (`build/`), no sources.
- Nothing under `fullstack/` is tracked by the pipeline today — not Java, not the
  19 existing `fullstack/scalus` projects.
- `frameworks.json` knows two kinds only: `onchain` and `offchain`.
- Dashboard columns are built as *onchain* + *(offchain × onchain)* cross-product.

## Decisions

| Decision | Choice |
| --- | --- |
| Fidelity of each example | **Faithful port** of that use case's real validator logic — matching datum/redeemer schema and every redeemer branch — not a demonstrative toy. |
| What CI runs (what a green cell certifies) | **Compile + unit + devnet run**: `./gradlew build` (julc lowering + julc-testkit local UPLC eval) then `./gradlew run` against Yaci DevKit with fail-closed proof the validator executed. |
| Registry scope | Add a generic third `kind: "fullstack"`, register **Java only** for now. Scalus can be added later as a one-line registry entry. |
| `token-transfer` | **Included.** It has its own 218-LOC Aiken validator, so it is not a duplicate of `simple-transfer`. |

## §1 Scope

**20 examples to build.** 19 use cases with empty `fullstack/java` placeholders:

`anonymous-data, auction, bet, constant-product-amm, crowdfund,
decentralized-identity, editable-nft, escrow, factory, htlc, lottery,
payment-splitter, pricebet, simple-transfer, simple-wallet, storage,
upgradable-proxy, vault, vesting`

plus `token-transfer`, which has no `fullstack/` directory at all and needs one created.

Total after this work: **21** Java fullstack examples (20 new + atomic-transaction).

### Port source per use case

"Faithful" needs a defined referent, and it differs by case:

- **18 cases** → port from `onchain/aiken/validators/*.ak`. This is canonical because
  every `offchain/*` implementation in the repo targets the Aiken blueprint. Where
  a `fullstack/scalus` validator also exists, cross-check against it.
- **`constant-product-amm`, `editable-nft`** → no Aiken validator exists. Port from
  their `fullstack/scalus` validators (212 and 198 LOC respectively).

The existing `offchain/ccl-java/*.java` for each case is a direct reference for the
off-chain flow — it uses the same library, so `App.java` is largely a restructuring
of that file around a julc-loaded script instead of a blueprint file.

## §2 Example template

Generalized from `atomic-transaction/fullstack/java/`; the layout is unchanged.

```
<use-case>/fullstack/java/
  settings.gradle              rootProject.name = 'java'; include('app')
  gradle.properties
  gradle/libs.versions.toml
  gradle/wrapper/              wrapper jar + properties
  gradlew  gradlew.bat
  .gitignore  .gitattributes  .vscode/settings.json
  app/build.gradle             julc + CCL deps, application plugin, Java 25 toolchain
  app/src/main/java/org/cardanofoundation/templates/
      validator/<Uc>Validator.java   julc @SpendingValidator / @MultiValidator
      App.java                       main() runs the full use-case lifecycle
  app/src/test/java/org/cardanofoundation/templates/
      <Uc>ValidatorTest.java         julc-testkit unit tests (real local UPLC eval)
  README.md
```

### Template changes, back-applied to atomic-transaction

All 21 examples must be identical in shape, so these apply to the existing example too.

1. **`App.main()` must exit non-zero on failure.**
   Today it prints `Transaction failed as expected: <bool>` and always exits 0.
   Under the chosen CI bar the job status is the process exit code, so as written a
   broken contract would report green. Every assertion in the flow must fail the
   process. This is the highest-priority change.

2. **Fail-closed proof the validator ran.**
   After the spending transaction confirms, assert the transaction has an **input at
   the script address** (via `getTransactionUtxos(txHash).getInputs()`). Do not use an
   "absence of UTxO at the script address" check — that false-passes when the lookup
   itself fails or returns empty. For mint-based examples, assert on policy id and
   asset quantity instead.

3. **`CARDANO_BACKEND_URL` environment override**, defaulting to the currently
   hardcoded `http://localhost:8080/api/v1/`. CI's yaci-devkit serves exactly that
   address, so the default keeps CI zero-config. The override exists because a local
   devkit frequently cannot bind `:8080`.

4. **Populate the empty `AppTest`** with julc-testkit unit tests covering each
   validator branch, including negative cases. Negative tests that mutate a hash or
   key must flip one byte at the **same length** — a different-length value can fail
   for the wrong reason.

5. **`.vscode/settings.json`: `java.debug.settings.onBuildFailureProceed` → `false`.**
   With `true`, a julc lowering failure leaves `build/classes/java/main` empty and the
   debugger then reports a misleading "Could not find or load main class", hiding the
   actual compile error.

6. **Version reconciliation.** The template pins `cardano-client-lib` `0.7.1` while
   `versions.json` pins `0.8.0-pre4`. Align them, and register `julc` in
   `versions.json` so the nightly version-sync job tracks it.

### Known julc constraints to expect

These have bitten this port before and should be anticipated rather than rediscovered:

- Record components must be read through the **accessor method** (`r.field()`), never
  as a bare field (`r.field`). `javac` accepts the direct read; julc aborts with
  `Plutus compilation error: Unbound variable: <field>`.
- `Optional.of(dynamicValue)` at a non-decode site emits an un-`bData`-wrapped
  `MkCons` and fails at eval — compare decoded fields directly instead.
- `serialiseData` can fail at eval; work around off-chain where possible.
- `ValuesLib.geq` crashes on `Value.zero()`; use `lovelaceOf(v).signum() > 0`.
- `ContextsLib.ownHash(ctx)` is SPEND-only; read `ScriptInfo` directly for
  WITHDRAW/CERTIFY purposes.
- `Builtins.*` (e.g. `sha3_256`) throw on the JVM — they are compile-time intrinsics.
  Use `java.security.MessageDigest` in test-side code.
- Validity ranges need a generous slot margin. The first local julc eval (Scala VM
  warm-up) plus submit can exceed 10s, and a tight `validTo` trips
  `OutsideValidityIntervalUTxO`.

Where a use case cannot reach exact parity because of a julc limitation, the
divergence is **documented explicitly** in that example's README rather than silently
reducing scope.

## §3 Pipeline integration

### 3.1 Registry entry

One new entry in `frameworks.json`:

```jsonc
{
  "id": "julc-java",
  "label": "julc + CCL (Java)",
  "kind": "fullstack",
  "discoveryPath": "fullstack/java/settings.gradle",
  "statusPrefix": "julc",
  "subdir": "fullstack/java",
  "runtime": "gradle",
  "versionFile": "fullstack/java/app/build.gradle"
}
```

`discoveryPath` resolves to `./<use-case>/fullstack/java/settings.gradle`, which is
depth 4 and therefore inside the existing `find . -maxdepth 4` in discovery.

### 3.2 Changes by file

| File | Change |
| --- | --- |
| `scripts/local-test-discovery.sh` | **No change required.** Its per-framework loop is kind-agnostic and emits `julc-examples.txt` / the `julc-examples` output automatically. The cross-product loop selects `kind == "offchain"` and `kind == "onchain"`, so fullstack is naturally excluded. |
| `.github/actions/setup-java-gradle/action.yml` *(new)* | Composite action: `actions/setup-java` (Temurin 25) + Gradle dependency/wrapper caching. Mirrors the existing `setup-*` actions rather than inlining setup in the workflow. Java 25 is required — the existing `setup-jbang-java` defaults to JDK 24 and is not reusable here. |
| `.github/workflows/_test-fullstack.yml` *(new)* | Reusable workflow, modelled on `_test-offchain.yml`. Matrix over examples; `setup-java-gradle`; `setup-yaci-devkit` with `start: true`; `./gradlew build`; `./gradlew run`; retry once after 15s; write `test-status.txt`; upload `logs-julc-<example>`. |
| `.github/workflows/ecosystem-test.yml` | Add a `test-fullstack` job (needs `discover`, `prepare-toolchains`) guarded by `needs.discover.outputs.julc-examples != '[]'`; add a conditional `setup-java-gradle` step to `prepare-toolchains`; expose `julc-examples` as a `discover` output; add `test-fullstack` to `report-and-dashboard`'s `needs`; add a status-reconstruct branch for `logs-julc-*`; add a count line to `report.md`. |
| `scripts/generate-dashboard.sh` | Add `FULLSTACK_FRAMEWORKS`; emit one column per fullstack framework with `kind: "fullstack"`; add a **third prefix-stripping loop** in example-name extraction; look up status at `<prefix>-<example>-status.txt`. |
| `docs/index.html` | Add `.kind-dot.fullstack` colour and chip tooltip text; render fullstack columns as their own group, outside the per-onchain pivot grouping. |
| `.github/workflows/ecosystem-test.yml` (lines 322–366) | **Bug fix** — see §3.4. |
| `scripts/local-test-fullstack.sh` *(new)* | Local equivalent of the CI job, with `ONLY_EXAMPLE` scoping for iteration. Runs examples **sequentially**. |
| `scripts/local-test-all.sh` | Wire the new script in as a step. |
| `docs/ADDING-A-LIBRARY.md` | Document the `fullstack` kind and how to add one. |

### 3.3 Status-file naming

Off-chain results are named `<offchain-prefix>-<onchain-id>-<example>-status.txt`;
on-chain results are `<onchain-prefix>-<example>-status.txt`. Fullstack has no
on-chain axis, so its files are `<prefix>-<example>-status.txt` — e.g.
`julc-htlc-status.txt`.

That shape is identical to the on-chain form, so `generate-dashboard.sh` must strip
fullstack prefixes explicitly. Its current extraction tries on-chain prefixes then
off-chain×on-chain prefixes; `julc` matches neither, so without the third loop
`julc-htlc-status.txt` never resolves to the use case `htlc` and the row silently
disappears.

Log artifacts follow the same rule: `logs-julc-<example>` (no on-chain segment).

### 3.4 Pre-existing bug to fix

`ecosystem-test.yml` reads, commits, and opens PRs against `dashboard/dashboard.json`
(lines 322–366), but `generate-dashboard.sh` writes `docs/dashboard.json` — the file
moved to `docs/` in commit `d0967fd` and the workflow was not updated. No `dashboard/`
directory exists, so the "Detect dashboard change" step always takes the
"missing — nothing to publish" branch and the dashboard never publishes.

Fixed as part of this work because it sits on the same publish path the new column
group depends on.

## §4 Execution and verification

### Sequencing

Prove the template end-to-end on **`htlc`** first — it has the smallest real validator
(43 LOC Aiken) and was the working reference in a prior iteration of this port. "End
to end" includes a green `test-fullstack` CI job, not just a local run. Landing the
pipeline plumbing against one working example is far cheaper than discovering a
job-definition problem 20 examples in.

Then fan out to the remaining 19, ordered roughly by validator complexity so that
template refinements surface early and cheaply.

### Acceptance criteria (per example)

1. `./gradlew build` green — julc lowers the validator to Plutus **and** julc-testkit
   unit tests pass.
2. `./gradlew run` green against Yaci DevKit, with the fail-closed proof from §2.2.
3. Exit code correct: 0 only when every assertion in the flow passed.
4. Any parity gap versus the Aiken/Scalus reference is documented in the example README.

### Acceptance criteria (pipeline)

1. `scripts/local-test-discovery.sh` lists all 21 examples under the `julc` prefix.
2. `scripts/generate-dashboard.sh` produces a `julc-java` column with a per-use-case
   status, and no use-case row is lost to prefix-stripping.
3. `docs/index.html` renders the fullstack group correctly in light and dark themes.
4. The dashboard publish step actually commits `docs/dashboard.json`.

### Local run constraint

Run devnet examples **sequentially** when testing locally. Concurrent runs starve the
single yaci-store `/evaluate` endpoint and produce spurious "Error while evaluating
script cost" failures that look like contract bugs. In CI each matrix job gets its own
runner and its own yaci instance, so parallelism there is safe.

If the local devkit cannot bind `:8080` (a conflicting stack is common on the dev
machine), relocate it and point examples at it via `CARDANO_BACKEND_URL`.

## Risks

- **Effort.** 20 faithful validator ports held to a live-devnet bar is a large,
  multi-session effort. The julc constraints listed in §2 are known to cause real
  friction on the more complex validators (`auction`, `crowdfund`, `upgradable-proxy`
  are 400–500 LOC of Aiken each).
- **CI cost.** 20 additional devnet jobs materially increase workflow wall-clock and
  runner minutes. If this proves too expensive, the fallback is to run the fullstack
  matrix only on `schedule` and `workflow_dispatch` rather than on every PR — but that
  is a change to make deliberately, not by default.
- **Devnet fragility.** The faucet exhausts after many top-ups and the store process
  can die independently of the node; both require a devkit restart. Examples self-fund
  and derive slot config at runtime, so a fresh devnet is always safe to re-run against.
