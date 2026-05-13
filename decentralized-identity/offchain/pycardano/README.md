# decentralized-identity — PyCardano Scenario

PyCardano 0.19.2 implementation of the DID (decentralized identity) validator.

## Scenario

1. **INIT** — owner creates the script UTxO with `IdentityDatum(owner, [])`.
2. **ADD_DELEGATE** — add a delegate with a future expiry timestamp.
3. **REMOVE_DELEGATE** — drop that delegate.
4. **TRANSFER_OWNER** — rotate the owner key.

The validator requires the owner signature on every transition and preserves
the UTxO value across updates.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python identity.py
```
