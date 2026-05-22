# escrow — PyCardano off-chain scenario

End-to-end scenario for the [two-party asset swap](../../onchain/aiken/validators/escrow.ak)
validator, written with [PyCardano](https://pycardano.readthedocs.io/) and
targeting a local [yaci-devkit](https://github.com/bloxbean/yaci-devkit) devnet.

The scenario is restricted to **lovelace-only** bundles so the `MValue` map
stays trivial (`{b"": {b"": amount}}`). The cancel branch is intentionally
omitted to keep the demo short.

## What it does

| Step | Actor      | Action                                                       |
|------|------------|--------------------------------------------------------------|
| 1    | Funder     | Fund 2 fresh wallets (initiator, recipient)                  |
| 2    | initiator  | INITIATE — lock 5 ADA at the escrow with `Initiation` datum  |
| 3    | recipient  | RECIPIENT_DEPOSIT — add 7 ADA, datum → `ActiveEscrow`        |
| 4    | both       | COMPLETE_TRADE — crossed payouts (each receives the other's) |

## Prerequisites

- Python 3.10+
- A running yaci-devkit instance on `http://localhost:8080`
- The validator must be compiled (`aiken build` in `escrow/onchain/aiken/`)

## Running

```bash
cd escrow/offchain/pycardano
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python escrow.py
```

Expected output ends with `=== Scenario complete ===`. The full run takes
~30–45 s.

## Plutus V3 Address encoding

The validator uses `cardano/address.{Address}` — `address_pub_key` is what
pulls a VKH out of it on-chain. We mirror its shape in PyCardano:

```python
# Credential = VerificationKey(hash) | Script(hash)
class VerificationKeyCred(PlutusData): CONSTR_ID = 0; hash: bytes
class ScriptCred(PlutusData):          CONSTR_ID = 1; hash: bytes

# Referenced = Inline(a) | Pointer(...)
class InlineRef(PlutusData):           CONSTR_ID = 0; cred: PlutusData

# Option = Some(a) | None
class SomeStakeCred(PlutusData):       CONSTR_ID = 0; cred: PlutusData
class NoStakeCred(PlutusData):         CONSTR_ID = 1

class PlutusAddr(PlutusData):
    CONSTR_ID = 0
    payment: PlutusData  # VerificationKeyCred or ScriptCred
    stake:   PlutusData  # NoStakeCred or SomeStakeCred(InlineRef(VerificationKeyCred))
```

A wallet address with stake key becomes:
`PlutusAddr(VerificationKeyCred(pay), SomeStakeCred(InlineRef(VerificationKeyCred(stake))))`.

## MValue encoding

`MValue = Pairs<PolicyId, Pairs<AssetName, Int>>` is a *type alias*, not a
wrapper. In a `@dataclass` field the type is just
`Dict[bytes, Dict[bytes, int]]` — Aiken's docs confirm `Pairs ≡ Map` at the
Data layer.

Lovelace-only: `{b"": {b"": amount}}` (empty policy + empty asset name).

## Datum / Redeemer

```python
# Datum
class Initiation(PlutusData):
    CONSTR_ID = 0
    initiator: PlutusAddr
    initiator_assets: Dict[bytes, Dict[bytes, int]]

class ActiveEscrow(PlutusData):
    CONSTR_ID = 1
    initiator: PlutusAddr
    initiator_assets: Dict[bytes, Dict[bytes, int]]
    recipient: PlutusAddr
    recipient_assets: Dict[bytes, Dict[bytes, int]]

# Redeemer (declared order: RecipientDeposit, CancelTrade, CompleteTrade)
class RecipientDeposit(PlutusData):
    CONSTR_ID = 0
    recipient: PlutusAddr
    recipient_assets: Dict[bytes, Dict[bytes, int]]

class CancelTrade(PlutusData):    CONSTR_ID = 1
class CompleteTrade(PlutusData):  CONSTR_ID = 2
```

`COMPLETE_TRADE` requires *both* parties' VKHs in `extra_signatories`, so the
transaction lists both as `required_signers` and is signed by both keys.
