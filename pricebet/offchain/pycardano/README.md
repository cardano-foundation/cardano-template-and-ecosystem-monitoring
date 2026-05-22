# pricebet — PyCardano off-chain scenario

End-to-end scenario for the [oracle-resolved price bet](../../onchain/aiken/validators/bet.ak)
validator, written with [PyCardano](https://pycardano.readthedocs.io/) and
targeting a local [yaci-devkit](https://github.com/bloxbean/yaci-devkit) devnet.

## What it does

| Step | Actor   | Action                                                       |
|------|---------|--------------------------------------------------------------|
| 1    | Funder  | Fund 2 fresh wallets (owner, player)                         |
| 2    | owner   | SETUP_ORACLE — publish oracle UTxO at always-true address    |
| 3    | owner   | CREATE bet (target=50, deadline=tip+120 slots, stake=5 ADA)  |
| 4    | player  | JOIN — match stake; pot becomes 10 ADA                       |
| 5    | player  | WIN — claim pot (oracle price=100 ≥ target=50)               |
| 6    | owner   | CREATE second bet with short deadline (tip+15 slots)         |
| 7    | —       | Wait for deadline                                            |
| 8    | owner   | TIMEOUT — reclaim pot                                        |

The oracle UTxO uses the **always-true PlutusV3 script** so anyone can spend it
(though we only reference-input it, never consume it). It carries an inline
`OracleDatum` with a `GenericData` constructor wrapping a `PriceMap` keyed:
`0→price, 1→timestamp, 2→expiry`.

## Prerequisites

- Python 3.10+
- A running yaci-devkit instance on `http://localhost:8080`
- The validator must be compiled (`aiken build` in `pricebet/onchain/aiken/`)

## Running

```bash
cd pricebet/offchain/pycardano
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python pricebet.py
```

Expected output ends with `=== Scenario complete ===`. The full run takes
~60–90 s due to the timeout wait in flow 2.

## Datum / Redeemer

```python
@dataclass
class SomePlayer(PlutusData):  # Option's Some
    CONSTR_ID = 0
    player: bytes

@dataclass
class NoPlayer(PlutusData):    # Option's None
    CONSTR_ID = 1

@dataclass
class PriceBetDatum(PlutusData):
    CONSTR_ID = 0
    owner: bytes
    player: PlutusData         # SomePlayer or NoPlayer
    oracle_vkh: bytes          # oracle script hash (28 bytes)
    target_rate: int
    deadline: int              # POSIX ms
    bet_amount: int

# Redeemer constructors:
class Join(PlutusData):    CONSTR_ID = 0
class Win(PlutusData):     CONSTR_ID = 1
class Timeout(PlutusData): CONSTR_ID = 2
```

The oracle datum uses the `GenericData` variant (Constr 2 of `PriceData`):

```python
@dataclass
class GenericData(PlutusData):
    CONSTR_ID = 2
    price_map: Dict[int, int]  # 0→price, 1→timestamp, 2→expiry

@dataclass
class OracleDatum(PlutusData):
    CONSTR_ID = 0
    price_data: PlutusData
```

Validator checks per redeemer:

- **Join**: input `player` is `None`, continuing output exists with
  `player = Some(joiner_vkh)`, all other fields preserved, pot ≥ 2×bet_amount,
  tx upper bound ≤ deadline, joiner signs.
- **Win**: input `player` is `Some(...)`, joiner signs, reference input at
  the oracle's script address has a fresh (`current_time ≤ expiry`)
  `OracleDatum` whose price ≥ target, payout to player ≥ pot, tx upper bound
  ≤ deadline.
- **Timeout**: tx lower bound > deadline, owner signs, payout to owner ≥ pot.
