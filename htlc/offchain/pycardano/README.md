# HTLC — PyCardano off-chain scenario

End-to-end scenario for the [Hash Time-Lock Contract](../../onchain/aiken/validators/htlc.ak)
validator, written with [PyCardano](https://pycardano.readthedocs.io/) and targeting
a local [yaci-devkit](https://github.com/bloxbean/yaci-devkit) devnet.

## What it does

The scenario exercises both spending paths of the HTLC validator:

| Step | Actor     | Action                                                   |
|------|-----------|----------------------------------------------------------|
| 1–2  | Owner     | Fund claimer (20 ADA) so it can pay collateral           |
| 3    | Owner     | Lock 10 ADA — secret `"open-sesame"`, expiry +1 h       |
| 4    | Owner     | Lock  8 ADA — secret `"another-secret"`, expiry +10 slots|
| 5    | Claimer   | Reveal `"open-sesame"` → GUESS redeemer (Constr 0)       |
| 6    | —         | Wait for chain tip to pass UTxO 2's expiry slot          |
| 7    | Owner     | Refund UTxO 2 → WITHDRAW redeemer (Constr 1)            |

UTxO 1 and UTxO 2 live at **different script addresses** because the script is
parameterised on `(sha256(secret), expiration_ms, owner_vkh)` — differing
parameters produce a different compiled script hash.

## Prerequisites

- Python 3.10+
- A running yaci-devkit instance on `http://localhost:8080`
- The validator must be compiled (`aiken build` in `htlc/onchain/aiken/`)

## Running

```bash
cd htlc/offchain/pycardano
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python htlc.py
```

Expected output ends with:

```
=== Scenario complete ===
```

The script exits 0 on success. The full run takes approximately 30–60 s due to
the wait for the short expiration in step 6.

## Validator parameters

The `htlc.htlc.spend` validator accepts three curried parameters:

| Parameter    | Type        | Description                                 |
|--------------|-------------|---------------------------------------------|
| `secret`     | `ByteArray` | `sha256(preimage)` — 32 bytes               |
| `expiration` | `Int`       | POSIX timestamp in **milliseconds**         |
| `owner`      | `ByteArray` | Owner's 28-byte verification key hash       |

Parameters are applied with `uplc_apply` in the order above.

## Redeemers

```python
@dataclass
class Guess(PlutusData):   # Constr 0
    CONSTR_ID = 0
    answer: bytes           # raw preimage, NOT the hash

@dataclass
class Withdraw(PlutusData): # Constr 1
    CONSTR_ID = 1
```

The `WITHDRAW` path requires:
- `validity_start > expiration_slot` (satisfies `valid_after`)
- Owner's VKH in `extra_signatories` (satisfies `key_signed`)
