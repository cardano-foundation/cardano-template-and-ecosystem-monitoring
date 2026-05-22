# token-transfer — PyCardano Scenario

End-to-end demonstration of the `token_transfer` validator using [PyCardano](https://github.com/Python-Cardano/pycardano).

## Scenario

1. **Generate** a fresh 24-word mnemonic and derive a new wallet (ensures asset-free start).
2. **Fund** the fresh wallet with 30 ADA from account 0 (shared test mnemonic).
3. **Mint** 10 `TestAsset` tokens under an always-true PlutusV3 minting policy. Send to the fresh wallet.
4. **Lock** all 10 tokens at the parameterised script address `(fresh_wallet_vkh, always_true_policy_id, b"TestAsset")`.
5. **Unlock** back to the fresh wallet — the receiver signs, all 10 TestAsset units return to the fresh wallet.

## Prerequisites

- Python 3.10+
- [yaci-devkit](https://github.com/bloxbean/yaci-devkit) running locally on port 8080

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python token_transfer.py
```

## On-chain validator

The validator is compiled from `token-transfer/onchain/aiken/validators/token-transfer.ak`:

```aiken
validator token_transfer(receiver: VerificationKeyHash, policy: PolicyId, assetName: ByteArray) {
  spend(_datum_opt, _redeemer, utxo, tx) { ... }
}
```

Three parameters are applied at script construction time:
- `receiver` — 28-byte payment VKH of the fresh wallet
- `policy` — 28-byte policy ID of the always-true minting script
- `assetName` — raw bytes of the token name (`TestAsset`)

## Always-true minting policy

A minimal PlutusV3 script that always succeeds (CBOR hex `46450101002499`).
The policy ID is derived deterministically from this script.

## Implementation notes

- Uses `HDWallet.generate_mnemonic(strength=256)` to produce a 24-word mnemonic.
- Script parameters are applied via `uplc` (`unflatten` → `apply` × 3 → `flatten`).
- The `YaciChainContext` subclass works around Conway-era protocol parameter
  differences in yaci-devkit's Blockfrost-compatible API.
- `auto_ttl_offset=300` is set on the unlock transaction to stay within
  yaci-devkit's short epoch boundary.
