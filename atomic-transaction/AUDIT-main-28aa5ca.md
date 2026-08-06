# NOBON Smart-Contract Audit — `main` @ `28aa5ca`

**Date:** 2026-08-05
**Commit:** `28aa5ca` — *Merge pull request #6 from Nobon-cardano/fix/sc-payout-binding*
**Branch:** `main` (up to date with `origin/main`)
**Toolchain:** Aiken `v1.1.22`, `aiken-lang/stdlib v3.0.0`, Plutus V3
**Baseline:** `aiken check` — **30/30 tests pass, 0 warnings**

**Scope** (source of truth = `.ak` only; comments treated as unverified claims):
`validators/{project,distribution,refund,export,minting,investment}.ak`,
`lib/{helpers,contract_invariants,types}.ak` — 3070 LOC.

---

## Executive summary

`main` now contains the full hardening line plus the payout-binding fixes. Re-verifying from scratch, **both blockers from my previous report are fixed**:

- **C-01 (was Critical)** — `seed_project_id` is now truncated to 28 bytes (`helpers.ak:178-185`), so CIP-67 names are `4 + 28 = 32` bytes and fit Cardano's `AssetName` limit. `MintProject` is mintable again.
- The `list.any(... >= amount)` payout checks in `refund`/`distribution` were replaced by `net_lovelace_gain` (`helpers.ak:241-243`), which nets inputs against outputs. This closes a genuine flaw: the old check was satisfied by the recipient's *own change output*, leaving the pool's ADA free to be routed to whoever built the transaction.

New defensive work also landed and verifies correctly: `funding_target_reachable` (rejects an unreachable target that would strand investors in `Active` forever), `aux_scripts_plausible` (rejects zero/duplicate/self/wrong-length aux hashes that would send the raise to an unspendable address), and `pool_terms_match` (pins the refund rate and deadline to the project — previously a hostile refund pool could advertise `ada_per_tonne = 1` and pay a lovelace for a thousand credits).

**One High finding remains**, and it is the same class of problem as before: an exactness check intended to eliminate rounding dust instead blocks legitimate claims.

| ID | Severity | Title | Location |
|----|----------|-------|----------|
| **H-01** | **High** | `FundPool` top-up not a multiple of `total_eligible_tokens` freezes all partial claims *and* `ClosePool` | `distribution.ak:136`, `:96-98`, `:177-178` |
| **M-01** | Medium | `investor_paid` is a balance check, not a payment check — repeat investors can be short-changed | `project.ak:805-817` |
| **M-02** | Medium | Distribution pool datum is unauthenticated (acknowledged in-code) | `distribution.ak:52-62` |
| **M-03** | Medium | All state-touching activity serialises on one UTxO; permissionless contention vector | design-wide |
| **M-04** | Medium | CIP-68 metadata accepted and silently ignored | `project.ak:441-451` |
| **M-05** | Medium | Residuals stranded forever if any holder never redeems | `distribution.ak:177`, `refund.ak:214` |
| L-01 | Low | `net_lovelace_gain` adds back the full `tx.fee` — payee underpayable by up to the fee | `helpers.ak:241-243` |
| L-02 | Low | Admin payout paths still use the weak `list.any` shape | `project.ak:150`, `distribution.ak:183`, `refund.ak:219` |
| L-03 | Low | Thread/reference NFTs unburnable, exit to admin — state-resurrection primitive | `project.ak:934`, `:953` |
| L-04 | Low | `RecoverLockedAda`'s `Active` branch is unreachable | `project.ak:966-968` |
| L-05 | Info | 10 dead helpers; `has_label_prefix`/`strip_label_prefix` duplicated | `helpers.ak`, `project.ak:34-48` |
| L-06 | Info | Deprecated validators still yield fund-trapping addresses | `minting.ak`, `investment.ak` |

**Verdict:** materially sound. The core value-conservation, supply-accounting and authorization logic verifies correctly across every path I walked. Fix H-01 before a real distribution round; the rest is hardening.

---

## H-01 (High) — A `FundPool` top-up can freeze the entire distribution pool

**Location:** `distribution.ak:131-136` (`Claim`), `:96-98` (`FundPool`), `:177-178` (`ClosePool`)

`Claim` computes a floor-divided payout and then demands it be exact:

```aiken
let claim_ada = a.tokens_used * pool.pool_ada / pool.total_eligible_tokens
expect claim_ada > 0
expect a.tokens_used * pool.pool_ada == claim_ada * pool.total_eligible_tokens
```

Writing `P = pool_ada`, `T = total_eligible_tokens`, `u = tokens_used`, this requires `T | u·P` — i.e. `u` must be a multiple of `T / gcd(P, T)`.

**Genesis is safe, and self-healing.** `StartDistribution` sets `P = collected_ada`, `T = circulating_supply`, and `Invest` enforces `ada·1000 == tokens·ada_per_tonne`, so `T | P` whenever `1000 | ada_per_tonne`. That invariant survives every claim: after claiming `u`, `P' = P − u·P/T = (P/T)·(T−u) = (P/T)·T'`, so `T' | P'` again. I verified this exhaustively for every `u` in a worked example.

**`FundPool` is what breaks it.** The redeemer explicitly allows an ADA-only top-up (`a.total_eligible_tokens >= 0`, comment: *"0 = ADA-only top-up"*). Since `T | P` already holds, preserving exactness requires the top-up `d` to satisfy **`T | d`** — an undocumented, unenforced constraint.

**Verified numerically** (`ada_per_tonne = 3_000_000`; investors hold 1000 and 3000 credits; `P = 12_000_000`, `T = 4000`):

| `FundPool` top-up `d` | Smallest claimable `u` | 1000-credit holder can claim? |
|---|---|---|
| genesis (none) | 1 | yes |
| **+1 lovelace** | **4000 (the entire float)** | **no** |
| +1_000_000 | 1 | yes |
| +1_500_000 | 1 | yes |
| +2_500_000 | 1 | yes |

Round ADA amounts happen to be multiples of `T` here and survive; a **1-lovelace** top-up — or any amount not divisible by `T` — leaves only the whole float claimable, so no individual investor can claim at all.

**The cascade.** With claims blocked, `total_eligible_tokens > 0` and `circulating_supply > 0`, so `ClosePool`'s gate also fails:

```aiken
expect pool.total_eligible_tokens == 0 || project.circulating_supply == 0
```

Nobody can spend the pool. The only exits are (a) the admin notices and tops up exactly `(−P) mod T` lovelace to restore divisibility, or (b) investors burn their credits via the permissionless `RecordBurn` **receiving nothing**, driving `circulating_supply` to 0 so the admin can `ClosePool` and take the whole pool.

**Impact.** A routine admin action with an unlucky amount silently freezes every investor's payout. Recoverable, but only by someone who knows the arithmetic — there is no error signalling it and no on-chain hint.

**Recommendation (preferred).** Drop the exactness gate. Floor division is already safe here because value is conserved explicitly (`out_pool.pool_ada == pool.pool_ada - claim_ada` and `out_lovelace == in_lovelace - claim_ada`), and the dust accrues to remaining claimants, with `ClosePool` sweeping the last of it:

```aiken
let claim_ada = a.tokens_used * pool.pool_ada / pool.total_eligible_tokens
expect claim_ada > 0
// Floor dust stays in the pool and accrues to remaining claimants.
```

**Alternative,** if exactness must stay: enforce the invariant at the point that can break it, in `FundPool` —
`expect a.pool_ada % next_eligible == 0` (or require proportional top-ups: `a.pool_ada * pool.total_eligible_tokens == a.total_eligible_tokens * pool.pool_ada`).

---

## Medium

### M-01 — `investor_paid` is a balance check, not a payment check

**Location:** `project.ak:805-817`

```aiken
let investor_paid =
  list.any(self.outputs, fn(o) {
    o.address.payment_credential == VerificationKey(invest.investor_vkh)
      && assets.quantity_of(o.value, carbon_policy, carbon_name) == expected_tokens
  })
```

This is exactly the shape that was correctly identified as broken for ADA and replaced with `net_lovelace_gain` in `refund.ak` and `distribution.ak` — but the carbon-side equivalent in `Invest` was not converted. It asserts *"an output to the investor holds N credits"*, not *"the investor gained N credits"*.

**Exploit.** An investor who already holds `≥ expected_tokens` credits (any repeat investor) spends one of their own UTxOs in the transaction. Their change output carries those pre-existing credits and satisfies the check unaided. The credits actually released by the project — enforced separately and correctly by `out_carbon + expected_tokens == in_carbon` — are then free to go to any other output, e.g. the transaction builder's.

The investor's ADA still reaches the project (`out_lovelace == in_lovelace + invest.ada_amount`), so they pay in full and receive nothing new. This matters because the intended flow has a backend build the transaction and the user sign it.

**Note:** the *protocol's* accounting stays consistent (`circulating_supply` rises correctly, inventory is debited correctly) — the loss is borne entirely by the investor. `export.ak:73-83` (`paid_destination`) has the same shape but is admin-only, so it is Low.

**Recommendation.** Add a `net_asset_gain` helper mirroring `net_lovelace_gain` (sum a policy/name over outputs to the payee, minus the same over their inputs) and require `net_asset_gain(self, investor_vkh, carbon) >= expected_tokens`.

### M-02 — Distribution pool datum is unauthenticated

**Location:** `distribution.ak:52-62` (the code documents this itself)

Anyone can create a UTxO at the distribution address with an arbitrary `DistributionDatum`. Since a claim pays `tokens_used · pool_ada / total_eligible_tokens`, inflating the divisor shrinks the payout for burned credits. The mitigation in place bounds it only by `expect pool.total_eligible_tokens <= project.max_supply`.

I confirmed the **real** pool cannot be drained this way: spending it still requires `Claim`/`FundPool`/`ClosePool` to pass against its own honest datum, and a hostile pool pays out of ADA the attacker themselves funded. The exposure is that a user can be induced to burn credits against a hostile pool at a punitive rate — the burn is irreversible, so they lose both the credits and the payout.

The in-code note is correct that the proper fix is an authentication token; `max_supply` cannot be tightened to `circulating_supply` because permissionless `BurnCarbon` legitimately retires credits without a claim.

**Recommendation.** Mint a pool NFT in `StartDistribution` (the project already pins the seed output, so it can require the NFT) and have `nobon_distribution` require it on the spent input. That converts the bound from heuristic to exact and removes the whole class.

### M-03 — Global serialisation on the project-state UTxO

Every `Invest` spends the project state. Every claim, refund and export burn must also spend it, because burning under the project policy invokes `BurnCarbon`/`BurnInventory`, both of which require `expect [project_input] = project_state_inputs(...)`. With `exactly_one_input_at_script_policy`, that permits **at most one state-touching transaction per block**.

Consequences: investment throughput is one tx/block during the raise; claim/refund campaigns queue globally; and because `RecordBurn` is permissionless, anyone willing to destroy credits can contend the state UTxO at will.

**Recommendation.** For redemption, move burn accounting off the hot path (per-user receipt UTxOs reconciled in batches), or introduce a batcher.

### M-04 — CIP-68 metadata accepted and ignored

**Location:** `project.ak:441-451`; `types.ak:53`

`MintProjectAction` carries a `Cip68Metadata` field that the `MintProject` branch never reads. The reference-NFT output is checked only for token quantities (`:482-484`) — its **datum is never inspected**. The label-100 token, whose entire purpose under CIP-68 is to carry the metadata datum, can be created with an empty or arbitrary datum.

For a carbon-credit instrument the metadata *is* the real-world claim, and the redeemer field misleads readers into believing it is enforced.

**Recommendation.** Require `reference_output.datum == InlineDatum(cfg.metadata)` and check `version`; or delete the field if metadata is deliberately off-chain.

### M-05 — Residuals stranded if any holder never redeems

**Location:** `distribution.ak:177-178`, `refund.ak:214`, `project.ak:940`, `:961`

`ClosePool`, `SweepResidual`, `ShutdownProject` and `RecoverLockedAda` all gate on `circulating_supply == 0`, which only falls when a holder actively burns. One lost key or abandoned wallet freezes the residual ADA — and the project state itself — permanently.

This is a deliberate and correct anti-rug trade-off, but it is unbounded in time with no fallback.

**Recommendation.** Add a long-dated backstop: allow the sweep when `circulating_supply > 0` but the validity interval starts after `deadline_posix_ms + grace` (12 months or more). Preserves protection through any realistic redemption window while guaranteeing eventual recovery.

---

## Low / Informational

**L-01 — `net_lovelace_gain` credits the full `tx.fee`** (`helpers.ak:241-243`).
`paid_to − supplied_by + fee` tolerates the payee being underpaid by up to `tx.fee`. The in-code rationale ("generous by exactly the fee — bounded, and small next to any real payout") holds for large payouts; for a claim or refund comparable to the fee, the payout can be reduced to nearly nothing while the check still passes. Economics limit this: a third-party builder who pays the fee spends more than they capture, so it is only profitable when the *victim's* inputs fund the fee, and the victim must sign. Bounded by `tx.fee` per transaction. Consider subtracting a caller-supplied fee allowance rather than the whole fee, or requiring `claim_ada > tx.fee`.

**L-02 — Admin payout paths still use the weak shape.**
`pays_admin_recovery_output` (`project.ak:150`), `ClosePool` (`distribution.ak:183`), `SweepResidual` (`refund.ak:219`) and export's residual drain (`export.ak:109`) still use `list.any(... lovelace == / >= X)` rather than `net_lovelace_gain`. Impact is low because the admin signs and is the beneficiary, but the inconsistency invites the pattern back into a future non-admin path.

**L-03 — Thread/reference NFTs are unburnable and exit to the admin.**
`ShutdownProject`/`RecoverLockedAda` require an output to the admin carrying the input's thread, reference and carbon quantities, and no burn arm accepts label-222/100 (both require `label_333_hex`). Whoever then holds the thread NFT can recreate a project-state UTxO at the project address with a **forged `ProjectDatum`**, which `referenced_project` (`contract_invariants.ak:146-168`) authenticates solely by "thread token, qty 1, at the project script". I found no profitable exploit today, because both exits already require `circulating_supply == 0` — by which point the pools are drainable legitimately. Rated Low as a latent primitive. Burning both NFTs on shutdown removes it.

**L-04 — Unreachable branch.** `RecoverLockedAda` permits `ProjectPhase.Active` (`:966-967`) while also requiring `collected_ada >= funding_target_ada` (`:956`), but `Invest` (`:838-841`) forces `Funded` the moment the target is met. Harmless; remove or annotate.

**L-05 — Dead helpers.** No call sites anywhere: `supply_ok`, `find_own_address`, `continuing_output`, `prefixed`, `carbon_ft_asset_name`, `base_name`, `same_base_name`, `minted_has_negative_quantity`, `minted_token_pairs`, `ada_for_tokens_exact`. Separately, `project.ak:34-48` defines private copies of `has_label_prefix`/`strip_label_prefix` that already exist in `helpers.ak` — two implementations of a security-relevant CIP-67 check can drift. (Credit where due: the previously-dangerous lower-bound deadline helpers were *removed*, with an excellent explanatory comment at `helpers.ak:35-50`.)

**L-06 — Deprecated validators.** `minting.ak` and `investment.ak` correctly return `False` on every purpose, but still compile to real addresses; anything sent there is unrecoverable. Drop from the build or document as poison.

---

## Verified sound

Checked specifically, no finding:

- **Value conservation.** Every continuing state pins ADA exactly (`out_lovelace == in_lovelace + ada_amount` on `Invest`; `out_lovelace + collected_ada == in_lovelace` on the two seeds) and carbon exactly (`out_carbon == in_carbon` on burn/transition arms, `out_carbon + expected_tokens == in_carbon` on `Invest`). No path leaks value.
- **Mint/spend pairing is structural.** Both handlers validate the *same* continuing datum, so mismatched pairs are contradictory: `BurnCarbon`+`RecordInventoryBurn` and `BurnInventory`+`RecordBurn` both fail on `circulating_supply`. Not a convention — an invariant.
- **Export cannot rug supply.** `export.ak:99` requires `out_p.circulating_supply == project.circulating_supply`, so `ExportTokens` is incompatible with `BurnCarbon`; inventory must retire via `BurnInventory`, which cannot drive `circulating_supply` to 0 and unlock the admin sweeps. Both inventory-burn arms further require a genuine export-script input holding the carbon.
- **Supply cap.** `lifetime_issued` (seeded to `initial_supply`) is preserved on every arm except the remint pair, which enforces `next_lifetime <= max_supply` *and* `circulating + on-state inventory <= max_supply`. Remint is correctly restricted to `Active`, with a sound rationale for why (`OpenExport` frees on-state slots without changing lifetime).
- **One-shot uniqueness.** Seed UTxO consumed + `project_id == blake2b_256(tx_id ‖ index)[0..28]` + "no thread NFT already in inputs" guard. The seed cannot be respent, so `project_id` and the thread NFT are unique. No arm can mint additional thread/reference tokens.
- **Stake-credential pinning.** All continuing-output filters compare the **full `Address`**; all three bootstrap seeds pin `stake_credential` to the project state's. No staking-reward hijack.
- **Aux-script pinning.** Seeds must land at the exact hash frozen in `ProjectDatum` at mint, and those hashes are immutable via `common_project_invariants`. `aux_scripts_plausible` additionally rejects zero, duplicate, self-referential and wrong-length hashes.
- **Refund terms bound to the project.** `pool_terms_match` pins `ada_per_tonne` and `deadline_posix_ms` against the live project — closing the hostile-refund-pool rate attack.
- **Deadline direction.** `Invest` checks the **upper** bound; `CloseUnfunded`, `RecoverLockedAda` and refund's `Active` gate check the **lower** bound. Unbounded intervals rejected in both directions. The exploitable lower-bound helpers were removed from the library.
- **Invest/refund math.** Exact-product equality in both directions; refund exactly reverses invest with no floor loss.
- **Double satisfaction.** `one_aux_script_input` forbids two burn-crediting aux validators (or two pools) in one transaction while still allowing the required project co-spend; `exactly_one_input_at_script_policy` blocks two project-policy inputs.
- **Token confinement.** `only_policy_assets` / `ada_only_value` applied to every continuing state and pool output; both implementations correct.
- **Purpose confinement.** Every validator's `else` branch returns `False` — withdraw-zero, certificate and vote purposes are all blocked.
- **Unreachable funding target.** `funding_target_reachable` rejects a target the full supply could never raise, which would otherwise strand investors in `Active` with no `StartDistribution` and no `RecoverLockedAda`.

---

## Prioritized remediation

1. **H-01** — remove the exactness gate in `Claim` (or enforce `T | d` in `FundPool`). Blocks real payouts.
2. **M-01** — convert `investor_paid` to a net-gain check.
3. **M-02** — add a pool authentication NFT.
4. **M-04** — enforce or remove the CIP-68 metadata datum.
5. **M-05** — long-dated backstop sweep.
6. **M-03** — plan batching before scaling redemption.
7. **L-01 → L-06** — fee allowance, payout-shape consistency, burn the thread NFT on shutdown, drop the unreachable branch and dead helpers, remove the deprecated validators.

## Reproducing

```bash
cd contracts/nobon
aiken check     # 30/30 pass, 0 warnings at 28aa5ca
```

No source files were modified by this review.
