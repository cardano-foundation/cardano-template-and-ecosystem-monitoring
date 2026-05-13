# vault — PyCardano Scenario

PyCardano 0.19.2 implementation of the `vault` validator (time-locked
two-step withdrawal).

## Scenario

The validator is parameterised by `(owner: VerificationKeyHash, waitTime: Int)`.
The scenario exercises both terminal paths:

- **Branch A** — `LOCK → WITHDRAW → FINALIZE`. Lock funds, schedule a
  withdrawal (stamping the UTxO with an inline `WithdrawDatum {lock_time}`),
  wait until the chain tip passes `lock_time + waitTime`, then `FINALIZE` to
  collect the funds.
- **Branch B** — `LOCK → WITHDRAW → CANCEL`. Lock funds, schedule a
  withdrawal, then immediately `CANCEL` to revert to a datum-less UTxO (the
  timer is reset).

A fresh wallet is generated and funded from account 0; that wallet is the
vault `owner`.

`waitTime` is set to `10_000` ms (~10 slots) so `FINALIZE` doesn't take long.

## Prerequisites

- Python 3.11+
- [yaci-devkit](https://github.com/bloxbean/yaci-devkit) running locally on
  port 8080.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python vault.py
```

## Implementation notes

- Parameters are applied via `uplc.tools.apply` since pycardano 0.19.2 has no
  `apply_params_to_script` helper.
- `WITHDRAW` uses tight validity bounds (`tip - 5` → `tip + 60`) with a
  `lock_time` set comfortably before `validity_start` so `valid_after(range,
  lock_time)` holds.
- `FINALIZE` polls the tip until `tip > (lock_time + waitTime)` slot, then
  pins `validity_start` strictly after that boundary.
- `CANCEL` emits a continuing output **without** a datum (preserving lovelace);
  the validator only enforces conservation here.
