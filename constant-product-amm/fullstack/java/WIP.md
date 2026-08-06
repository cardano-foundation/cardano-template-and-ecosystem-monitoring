# constant-product-amm — work in progress, NOT wired into the pipeline

`settings.gradle` is renamed to `settings.gradle.wip` on purpose: that file is the discovery
marker (`frameworks.json` → `discoveryPath: fullstack/java/settings.gradle`), so while it is
renamed this example is invisible to `local-test-discovery.sh` and cannot produce a failing
dashboard cell. Rename it back once the deposit works.

## Done

- `AmmValidator` — full port of `constant-product-amm/fullstack/scalus/AmmValidator.scala`,
  compiling to Plutus V3. Multi-validator: guards the pool and mints LP, so the LP policy id is
  the script hash.
- `AmmValidatorTest` — **14 tests, all passing** on a real Plutus VM, including the two that
  matter most: `datumMustMatchTheTokensActuallyHeld` (a datum that balances while the tokens go
  elsewhere) and the integer-sqrt bounds on the first deposit.
- `App` — minting the pair and creating the empty pool both succeed on chain.

## Blocked

The **initial deposit** is refused.

**Narrowed:** the 14 unit tests exercise the *spend* path with identical params and datums and
all pass, so the arithmetic and the reserve binding are sound. The on-chain deposit differs by
also invoking the **mint** endpoint in the same transaction (it mints the LP tokens). That makes
`mint()` the prime suspect, and it is untested — there is no unit test for it.

**`mint()` has now been unit-tested and CLEARED** — 3 tests (`mintReconcilesTheLpDelta`,
`mintRejectsAnLpDeltaThatDisagreesWithTheDatum`, `burnReconcilesTheLpDelta`) all pass. 17 tests
total, all green. So neither endpoint is wrong in isolation.

That leaves the *combination* or the transaction shape. The one structural difference between
the passing unit tests and the on-chain deposit that has NOT been reproduced in a test: the real
empty pool holds **no pair tokens at all** (only ada), whereas every spend test gives the input
`reserves(1000, 4000)`.

**The single-`ScriptTx` restructure does NOT apply here** — `deposit()` and `swap()` already
build one `ScriptTx` with no composed wallet `Tx`. That was checked, not assumed.

**RULED OUT — dual purpose is not the cause.** The pool was seeded directly by a plain payment
(no validator) and a *swap* attempted, which mints nothing and therefore uses only the spending
purpose. It fails identically. Also ruled out: the trader running short of token0 (the pool
absorbs exactly R0/R1, so a surplus is now minted — no change in behaviour).

What this narrows it to: the **spend path alone**, on a transaction whose only script action is
the swap. The corresponding unit test (`swapFollowsTheCurve`, same reserves, same amounts, same
expected datum) PASSES, and the negative case (`Swap with mismatched reserves`) is correctly
refused on chain — so the validator runs and discriminates. Something about the real
transaction's shape differs from the test's in a way the test does not model.

**MEASURED (finally).** Supplying a stub `withTxEvaluator` gets past the backend's cost
evaluation so `.build()` returns an inspectable `Transaction`. The swap's body is *correct*:

    inputs = 2  (pool + one wallet utxo)
    out[0]  pool address, coin=5000000, 1 multiasset policy, inline datum present
    out[1]  trader change

So the off-chain transaction shape is NOT the fault — that eliminates input/output ordering,
missing tokens, the dual purpose, and trader balance, all of which were guesses.

**What remains, in order:**
1. ~~Nested `@Param` records~~ — **RULED OUT.** `AmmParams` has been flattened to six flat
   parameters (`t0Policy, t0Name, t1Policy, t1Name, feeNumerator, feeDenominator`); 17 tests
   still pass and the on-chain swap fails identically. The flattening was kept — it is clearer
   regardless — but it was not the cause.

   Original reasoning, for the record: `AmmParams` was a `@Param` record containing nested records (`TradedToken`), and
   `params.t0().policyId()` is a two-level field access through a parameter — deeper than any
   other validator in this repo. The unit tests apply params via `JulcEval.forClass(class,
   params)` while the chain gets them via `JulcScriptLoader.load(class, params)`; if those two
   paths encode nested records differently, every reserve-binding comparison would read garbage
   and reject. **Test this first**: flatten `AmmParams` to four flat fields
   (`t0Policy, t0Name, t1Policy, t1Name, feeNum, feeDen`) and re-run. If it passes, the nesting
   was the cause.
2. Failing that, dump the pool output's actual asset quantities (the dump above only counted
   policies, not amounts) and compare against `next.r0()`/`next.r1()`.

**Superseded hypothesis (kept for the record): one script serving two purposes.** The deposit
does `attachSpendingValidator(amm)` *and* `mintAsset(amm, ...)` — the same script hash acting as
both spending validator and minting policy, needing two redeemers (the `Deposit` constr for the
spend, `unit()` for the mint). Every other multi-validator example in this repo exercises only
one purpose per transaction, so this path is untested anywhere else.

Worth checking, in order:
1. Whether cardano-client-lib attaches the script once and registers both redeemers correctly,
   or crosses them — if the spend received `unit()` it would fail to decode `AmmRedeemer` and
   reject exactly as observed. Inspect `TxContext.build()`'s witness set offline.
2. Failing that, split the deposit into two transactions (mint LP first to the trader, then a
   pure spend), which sidesteps the dual purpose entirely at the cost of departing from the
   Scalus original's single-transaction shape.

Also still unreproduced in a test: the real empty pool holds **only ada**, whereas every spend
test gives the input `reserves(1000, 4000)`. Cheap to add and worth ruling out.

Other candidates, in order:

1. The LP mint and the pool spend both invoke this script in one transaction. The MINT endpoint
   looks for a pool *input* at its own script hash and a single continuing output — check that
   the empty pool UTxO created by `openPool()` is found by that filter.
2. `poolValue(...)` uses `Amount.asset(policyId, name, qty)`, which hex-encodes `name` itself.
   That is correct here because the names are plain ASCII, but worth confirming against what the
   pair policy actually minted.
3. The empty pool is created with datum `(0,0,0)` but holds no pair tokens, so the reserve
   binding at the end of `spend` compares `quantityOf(...) === 0` — verify julc returns 0 rather
   than failing for an absent asset.

## Note on a julc trap found here

A `return false` nested inside an if/else **branch**, followed by more code in the method, does
not lower the way it reads — three deposit/redeem/swap guards were silently skipped and bad
transitions passed. Rewriting each handler as a single boolean expression fixed it. Top-level
early returns in a method are fine; it is the nested ones that bite.


## Everything ruled out so far

Measured, not guessed, unless noted:

- off-chain transaction shape — **measured correct** (2 inputs; pool output with right ada,
  pair assets and inline datum) via a stub `withTxEvaluator` + `.build()`
- one script serving two purposes in one tx — tested by seeding the pool directly and swapping
  (no mint at all); fails identically
- trader running short of token0 — surplus minted; no change
- nested `@Param` records — flattened; no change
- both endpoints in isolation — 17 unit tests pass, including `mint()` and the exact swap
  numbers used on chain
- the negative swap IS correctly refused on chain, so the validator runs and discriminates

- output asset **quantities** — **measured correct**: pool output carries name0=1100 and
  name1=3638, exactly `next.r0()`/`next.r1()`
- both pair tokens sharing one policy id — the App now mints them under two distinct policies
  (matching what the unit tests model, and what a real pair looks like); fails identically

- pool datum inline vs hashed — **measured**: `inline_datum` present and decoding to
  `{constructor 0, fields [1000, 4000, 2000]}`, `data_hash` null. So the typed datum parameter
  resolves, and the negative swap really is being refused on its merits rather than on a datum
  failure.

## What has NOT been checked

Everything observable off-chain has now been measured and is correct. The transaction the node
rejects carries the right inputs, the right outputs, the right asset quantities under the right
policies, and the right inline datum — and the *negative* case is still correctly refused, so
the script runs and discriminates.

That leaves only the compiled script's own behaviour. Remaining suspects, in order:

1. **`BigInteger.divide` on chain vs the JVM.** `sells(...)` computes
   `reserveOut * adjusted / (reserveIn * feeDenominator + adjusted)`. Plutus integer division
   truncates toward negative infinity; `BigInteger.divide` truncates toward zero. Identical for
   positive operands — which these are — but worth confirming julc lowers it to the flooring
   builtin and not something else. **Cheapest check**: add a unit test asserting the exact
   quotient 398800000 / 1099700 = 362 through the compiled script rather than in Java.
2. **`ValuesLib.lovelaceOf` / `assetOf` on the pool output.** The unit tests build values with
   `Value.singleton(...).merge(...)`; the chain builds them from CBOR. If the on-chain value's
   internal ordering differs, a lookup could miss. Test by decoding the real output's value from
   the dump and feeding *that* into the evaluator.

Both are unit-testable without a devnet round-trip, which is where the next session should
start — no more on-chain guessing.
