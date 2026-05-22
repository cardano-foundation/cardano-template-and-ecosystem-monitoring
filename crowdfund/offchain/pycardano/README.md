# crowdfund — PyCardano Scenario

PyCardano 0.19.2 implementation of the all-or-nothing `crowdfund` validator.

## Scenario

The validator is parameterised by
`(beneficiary: VerificationKeyHash, goal: Int, deadline: Int)`. It holds a
single script UTxO whose datum is a per-donor ledger of contributions
(`Pairs<VerificationKeyHash, Int>`). Off-chain logic exercises:

- **Campaign A** — small goal, met:
  `INIT → DONATE → WITHDRAW`. The beneficiary withdraws the full pot after
  the deadline.
- **Campaign B** — unreachable goal, unmet:
  `INIT → DONATE → RECLAIM`. The donor reclaims their contribution.

Three fresh wallets are generated and funded from account 0 (owner,
beneficiary, donor) so the campaigns run on clean state.

## Prerequisites

- Python 3.11+
- [yaci-devkit](https://github.com/bloxbean/yaci-devkit) running locally on
  port 8080.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python crowdfund.py
```

## Implementation notes

- `Pairs<K,V>` is represented as `Dict[bytes, int]` inside a `PlutusData`
  dataclass; pycardano serialises it as a CBOR map, matching Aiken's wire
  format.
- The `RECLAIM` partial branch wraps the continuing datum in
  `Some(CrowdfundDatum(..))` — the validator's pattern is
  `expect Some(CrowdfundDatum { wallets }) = ...`. A separate
  `SomeCrowdfundDatum` dataclass handles this.
- `WITHDRAW` and `RECLAIM` set `validity_start = max(deadline_slot + 1, tip - 5)`
  so `valid_after(range, deadline)` succeeds.
- Parameters are applied via `uplc.tools.apply` (no `apply_params_to_script`
  in pycardano 0.19.2).
