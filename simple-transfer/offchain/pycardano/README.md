# simple-transfer — PyCardano off-chain

PyCardano 0.19.2 implementation of the `simple-transfer` scenario.

## What it does

1. Derives account 0 (funder) and account 1 (recipient) from the shared test mnemonic.
2. Funds account 1 with 25 ADA from account 0.
3. Locks 10 ADA at a PlutusV3 script parameterised on account 1's payment VKH.
4. Account 1 claims the locked UTxO by signing the transaction.
5. Prints `=== Scenario complete ===` and exits 0.

## Prerequisites

- Python 3.11+
- [yaci-devkit](https://github.com/bloxbean/yaci-devkit) running locally
  (Blockfrost-compatible API at `http://localhost:8080/api/v1`)
- Aiken smart contract compiled: `simple-transfer/onchain/aiken/plutus.json`
  must exist (run `aiken build` inside `simple-transfer/onchain/aiken/` if not)

## Local run

```bash
# From this directory:
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python simple_transfer.py
```

Expected output (timings vary):

```
=== simple-transfer scenario: fund → lock → claim ===
Connected to yaci-devkit (epoch N)
Recipient (account 1): addr_test1...
Funding addr_test1... with 25000000 lovelace from account 0 ...
  Submitted FUND: tx=<hash>
Locking 10000000 lovelace at script addr_test1... (receiver VKH=...) ...
  Submitted LOCK: tx=<hash>
Claiming from script addr_test1... with account 1 ...
  Found 1 UTxO(s) at script address.
  Submitted CLAIM: tx=<hash>
=== Scenario complete ===
```

The script is idempotent: running it again simply adds more funds and locks
another UTxO (yaci-devkit retains state between runs).

## Notes

- `pycardano==0.19.2` does not ship `apply_params_to_script`; parameter
  application is done directly via the `uplc` library
  (`uplc_unflatten` → `uplc_apply` → `uplc_flatten`).
- The `BLOCKFROST_API_VERSION=v1` environment variable corrects the URL
  that the `blockfrost-python` client constructs (it defaults to appending
  `/v0`).
