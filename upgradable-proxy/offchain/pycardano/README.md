# upgradable-proxy — PyCardano scenario

End-to-end scenario for the upgradable-proxy validators against a local
[yaci-devkit] (`http://localhost:8080`).

## Validators

| Validator | Title | Params |
| --------- | ----- | ------ |
| proxy.mint   | `proxy.proxy.mint`                                       | `(utxo_ref: OutputReference)` |
| proxy.spend  | `proxy.proxy.spend`                                      | `(utxo_ref: OutputReference)` |
| logic v1     | `script_logic_v_1.script_logic_version_1_0.withdraw`     | `(proxy_policy_id: PolicyId)` |
| logic v2     | `script_logic_v_2.script_logic_version_1_0.withdraw`     | `(proxy_policy_id: PolicyId)` |

The proxy is parameterised by a *seed* UTxO so its policy hash is unique
per deployment. The state token name is `sha3_256(tx_id || utf8(str(idx)))`.

Logic is invoked indirectly: every proxy.mint MINT and proxy.spend SPEND
must include a *withdrawal* whose credential equals the current
`script_pointer`. To swap versions, the proxy.spend UPDATE rule rotates
that pointer in the state UTxO's datum.

## Scenario

`run_scenario()` exercises the upgrade flow end-to-end:

1. **Fund** owner with 5 pure-ADA UTxOs (one becomes the seed, others stay
   available as collateral candidates).
2. **init** — single tx that:
   - mints the state token,
   - locks it at the proxy script address with
     `ProxyDatum { script_pointer = v1_hash, script_owner = owner_vkh }`,
   - attaches the proxy script as the output's reference script,
   - registers the v1 logic's stake credential.
3. **mint(v1)** — mint a ProxyMintToken under the proxy policy. Includes a
   withdrawal of 0 lovelace from the v1 logic's reward address with the
   logic-v1 redeemer `{ token_name = "ProxyMintToken", password = "Hello, World!" }`
   (v1 enforces the token name and ignores password during mint).
4. **change_version** — spend the state UTxO with `UPDATE`, continue the
   state token forward with `script_pointer = v2_hash`, include the v1
   logic withdrawal as the "outgoing logic" sign-off, and register the v2
   stake credential.
5. **mint(v2)** — same shape as step 3 but the redeemer is now
   `{ invalid_token_name = "InvalidToken" }`. v2 only accepts mints where
   `asset_name != invalid_token_name`, so we mint `ProductV2`.

## Run

```bash
pip install -r requirements.txt
python upgradable_proxy.py
```

Requires yaci-devkit listening on `http://localhost:8080`.

## Notes / risky guesses

- **change_version withdrawal**: the on-chain `proxy.spend UPDATE` rule
  does NOT require a withdrawal from the current logic — but the
  reference implementation in meshjs (`proxy.ts`) does include one in the
  UPDATE transaction. The script makes that withdrawal effectively
  optional. We include it here for symmetry with the meshjs reference.
- **state token derivation**: the on-chain name is
  `sha3_256(transaction_id || utf8(string(output_index)))`. We replicate
  that exactly.
- **PlutusV3 reference script on the state output**: published once at INIT,
  reused by `add_script_input` on UPDATE (the script is auto-detected from
  the input UTxO).
