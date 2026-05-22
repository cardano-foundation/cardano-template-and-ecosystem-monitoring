# bet — PyCardano off-chain scenario

End-to-end scenario for the [two-player bet](../../onchain/aiken/validators/bet.ak)
validator, written with [PyCardano](https://pycardano.readthedocs.io/) and
targeting a local [yaci-devkit](https://github.com/bloxbean/yaci-devkit) devnet.

## What it does

A single PlutusV3 validator handles both the mint (CREATE/INIT) and spend
(JOIN, ANNOUNCE_WINNER) of an oracle-resolved bet.

| Step | Actor    | Action                                                  |
|------|----------|---------------------------------------------------------|
| 1    | Funder   | Fund 3 fresh wallets (player1, player2, oracle)         |
| 2    | player1  | INIT — mint 1 bet token, lock 10 ADA + datum            |
| 3    | player2  | JOIN — spend script UTxO, double pot to 20 ADA          |
| 4    | —        | Wait for tip to pass expiration slot                    |
| 5    | oracle   | ANNOUNCE_WINNER — settle, pay 20 ADA to winner (player1)|

The minted token serves as the bet's identity. It travels with the script
UTxO across JOIN and is paid to the winner on ANNOUNCE_WINNER.

## Prerequisites

- Python 3.10+
- A running yaci-devkit instance on `http://localhost:8080`
- The validator must be compiled (`aiken build` in `bet/onchain/aiken/`)

## Running

```bash
cd bet/offchain/pycardano
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python bet.py
```

Expected output ends with `=== Scenario complete ===`. The full run takes
~60–90 s due to the wait for the bet expiration.

## Datum / Redeemer

```python
@dataclass
class BetDatum(PlutusData):    # Constr 0
    CONSTR_ID = 0
    player1: bytes             # VKH
    player2: bytes             # VKH or b"" sentinel until joined
    oracle: bytes              # VKH
    expiration: int            # POSIX milliseconds

@dataclass
class Join(PlutusData):        # Constr 0 (first of Action)
    CONSTR_ID = 0

@dataclass
class AnnounceWinner(PlutusData):  # Constr 1
    CONSTR_ID = 1
    winner: bytes              # VKH
```

The validator enforces:

- `INIT`: one script output, signed by player1, player2 sentinel == `""`,
  oracle ≠ player1, tx ends before the expiration.
- `JOIN`: input has a token whose policy == script hash (the bet's identity),
  one continuing script output, player2 signs, all datum fields copied,
  output lovelace exactly 2× input lovelace, tx ends before expiration.
- `ANNOUNCE_WINNER`: one output (the payout), no datum, addressed to
  `from_verification_key(winner)` (enterprise — no stake credential),
  oracle signs, tx starts strictly after the expiration.
