# vesting — PyCardano off-chain

PyCardano 0.19.2 implementation of the `vesting` scenario.

## What it does

1. Derives account 0 (owner/funder) and account 1 (beneficiary) from the shared test mnemonic.
2. Funds account 1 with 20 ADA from account 0 (so it can pay collateral).
3. Deposits 5 ADA at the vesting script with `lock_until` = now + 1 hour — this UTxO will be reclaimed by the owner.
4. Deposits another 5 ADA with `lock_until` = current tip + ~10 slots — this UTxO will be claimed by the beneficiary.
5. Owner withdraws the first UTxO (clawback path — owner signature only, deadline has not passed).
6. Waits for the chain tip to pass the second UTxO's deadline slot.
7. Beneficiary withdraws the second UTxO with `validity_start > lock_until` and beneficiary's signature.
8. Prints `=== Scenario complete ===` and exits 0.

## Prerequisites

- Python 3.11+
- [yaci-devkit](https://github.com/bloxbean/yaci-devkit) running locally
  (Blockfrost-compatible API at `http://localhost:8080/api/v1`)
- Aiken smart contract compiled: `vesting/onchain/aiken/plutus.json`
  must exist (run `aiken build` inside `vesting/onchain/aiken/` if not)

## Local run

```bash
# From this directory:
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python vesting.py
```

Expected output (timings vary; the wait for the short lock takes ~10s):

```
=== vesting scenario: fund → deposit×2 → owner-withdraw → wait → beneficiary-withdraw ===
Connected to yaci-devkit (epoch N)
Owner     (account 0): addr_test1...
Beneficiary (account 1): addr_test1...
Vesting script address: addr_test1...
Slot config: zero_time_ms=..., zero_slot=0, slot_length_ms=1000
Funding beneficiary addr_test1... with 20000000 lovelace ...
  Submitted FUND: tx=<hash>
Depositing 5 ADA for owner clawback (lock_until=... ms, ~1h from now) ...
  Submitted DEPOSIT_OWNER: tx=<hash>
Depositing 5 ADA for beneficiary claim (lock_until slot=..., ms=...) ...
  Submitted DEPOSIT_BENEF: tx=<hash>
Owner withdrawing UTxO from tx <hash>... (clawback) ...
  Submitted OWNER_WITHDRAW: tx=<hash>
Waiting for tip to pass slot ...
  Tip=..., past deadline slot ...
Beneficiary withdrawing UTxO from tx <hash>... (deadline path) ...
  Submitted BENEFICIARY_WITHDRAW: tx=<hash>
=== Scenario complete ===
```

## Notes

- The vesting validator has **no script parameters** — `PlutusV3Script(compiled_code)` is
  constructed directly from the `compiledCode` field in `plutus.json` without any
  `apply_params_to_script` call.
- Datum fields `owner` and `beneficiary` are raw payment VKH bytes (28 bytes each),
  matching what the Aiken validator checks via `key_signed(tx.extra_signatories, ...)`.
- `BLOCKFROST_API_VERSION=v1` corrects the URL that `blockfrost-python` constructs
  (it defaults to appending `/v0`).
- The `YaciChainContext` subclass patches several Conway-era protocol parameter
  differences and handles HTTP 202 responses from yaci-devkit.
- Slot/time conversion computes `zero_time_ms = (block.time - block.slot) * 1000`
  from the latest block header. This exactly matches how ogmios translates slot
  numbers to POSIX milliseconds inside the Plutus evaluator, so `valid_after`
  checks pass correctly.
