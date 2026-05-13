# auction — PyCardano off-chain scenario

End-to-end scenario for the [English auction](../../onchain/aiken/validators/auction.ak)
validator, written with [PyCardano](https://pycardano.readthedocs.io/) and
targeting a local [yaci-devkit](https://github.com/bloxbean/yaci-devkit) devnet.

## What it does

A single PlutusV3 validator handles both the mint (START) and spend (BID, END).
The auctioned NFT is minted under the validator's own policy and serves as
the auction's identity — it remains at the script UTxO across all bids and
moves to the winner only at END.

| Step | Actor    | Action                                                    |
|------|----------|-----------------------------------------------------------|
| 1    | Funder   | Fund 3 fresh wallets (seller, bidder1, bidder2)           |
| 2    | seller   | START — mint NFT, lock at script with 3 ADA starting bid  |
| 3    | bidder1  | BID — outbid to 6 ADA (no previous bidder to refund)      |
| 4    | bidder2  | BID — outbid to 10 ADA, refund bidder1's 6 ADA            |
| 5    | —        | Wait for tip to pass expiration slot                      |
| 6    | seller   | END — NFT to bidder2, 10 ADA to seller, script UTxO gone  |

## Prerequisites

- Python 3.10+
- A running yaci-devkit instance on `http://localhost:8080`
- The validator must be compiled (`aiken build` in `auction/onchain/aiken/`)

## Running

```bash
cd auction/offchain/pycardano
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python auction.py
```

Expected output ends with `=== Scenario complete ===`. The full run takes
~60–90 s due to the wait for the auction expiration.

## Datum / Redeemer

```python
@dataclass
class AuctionDatum(PlutusData):
    CONSTR_ID = 0
    seller: bytes
    highest_bidder: bytes      # b"" sentinel until first non-zero bid
    highest_bid: int
    expiration: int            # POSIX milliseconds
    asset_policy: bytes
    asset_name: bytes

# Redeemers (declared order):
class Bid(PlutusData):      CONSTR_ID = 0
class Withdraw(PlutusData): CONSTR_ID = 1  # validator always-fails this branch
class End(PlutusData):      CONSTR_ID = 2
```

Notes:

- `Withdraw` is declared on-chain but unconditionally fails — losing bidders
  are refunded inline during each `Bid`, not via a separate path.
- `END` payouts route to **enterprise** addresses (`from_verification_key`),
  matching how the validator constructs the seller/winner address with no
  stake credential.
