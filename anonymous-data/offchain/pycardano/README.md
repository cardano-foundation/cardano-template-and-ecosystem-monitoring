# anonymous-data — PyCardano Scenario

PyCardano 0.19.2 implementation of the anonymous-data commit/reveal validator.

## Scenario

1. **Generate** a fresh wallet, fund 30 ADA from account 0.
2. **COMMIT** — compute `id = blake2b_256(pkh || nonce)`. Mint 1 singleton
   token under the script's policy with asset name = `id`; send to the script
   address with the opaque payload as inline datum.
3. **REVEAL** — spend the committed UTxO. Redeemer = `nonce`. The validator
   recovers `id` from the spent value and verifies a signer's
   `blake2b_256(pkh || nonce) == id`.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python anonymous_data.py
```
