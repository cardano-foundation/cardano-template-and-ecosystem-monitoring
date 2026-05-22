# storage — PyCardano Scenario

PyCardano 0.19.2 implementation of the `storage` validators (an append-only
audit registry).

## Scenario

The on-chain pair is:

- `mint.mint.mint` — parameterised by `(seed_utxo: OutputReference, validator_hash: ByteArray)`.
  A one-shot policy: it mints exactly one token (asset name = `sha2_256(snapshot_id)`)
  and forces the NFT plus a matching `RegistryDatum` to a UTxO at the storage
  spend address.
- `storage.storage.spend` — no parameters; the spend path always fails so the
  registry entries become immutable.

The script:

1. Resolves the **storage spend script hash** (no parameters).
2. Picks a non-collateral UTxO from account 0 to use as the **seed**.
3. Applies `(seed_utxo, validator_hash)` to the mint policy.
4. **Publishes** a snapshot: mints the singleton NFT and locks it at the
   storage script with an inline `RegistryDatum`.
5. Repeats with a `Monthly` snapshot type.

No spend attempt is made — the storage validator hard-fails by design.

## Prerequisites

- Python 3.11+
- [yaci-devkit](https://github.com/bloxbean/yaci-devkit) running locally on
  port 8080.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python storage.py
```

## Implementation notes

- The mint script is parameterised via `uplc.tools.apply` since pycardano 0.19.2
  has no `apply_params_to_script` helper. `OutputReference` is encoded as
  `PlutusConstr(0, [PlutusByteString(tx_id), PlutusInteger(index)])`.
- The seed UTxO is filtered to avoid yaci-devkit's collateral-only 5 ADA UTxO.
- Tight validity bounds (`tip - 5` → `tip + 60`) keep script evaluation within
  yaci-devkit's foreseeable era horizon.
- `SnapshotType` is represented as two zero-field `PlutusData` classes
  (`Daily` = Constr 0, `Monthly` = Constr 1).
