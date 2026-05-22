# atomic-transaction — PyCardano Scenario

PyCardano 0.19.2 implementation of the `atomic-transaction` validator using the
single PlutusV3 script that handles both mint and spend.

## Scenario

1. **Generate** a fresh 24-word mnemonic and derive a new wallet.
2. **Fund** the fresh wallet with 50 ADA from account 0.
3. **MINT+LOCK** — mint 1 `AtomicToken` and lock it at the script address with
   the password redeemer stored as inline datum.
4. **COLLECT** — one transaction that simultaneously spends the locked UTxO
   and mints a second `AtomicToken`. Both tokens go to the wallet.
5. **BURN** — burn the 2 tokens with `mint(-2)`.

## Prerequisites

- Python 3.11+
- [yaci-devkit](https://github.com/bloxbean/yaci-devkit) running locally on
  port 8080.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python atomic_transaction.py
```

## Implementation notes

- Tight validity bounds (`tip - 5` → `tip + 60`) keep script evaluation within
  yaci-devkit's foreseeable era horizon.
- The validator parameters are 0 — the compiled script is used directly.
- The mint redeemer is also written as the inline datum so the spend can
  retrieve the password it used to lock.
