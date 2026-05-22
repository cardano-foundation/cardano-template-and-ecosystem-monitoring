# simple-wallet — PyCardano scenario

End-to-end scenario for the three simple-wallet validators against a local
[yaci-devkit] (`http://localhost:8080`).

## Validators

| Validator | Title | Params (in declaration order) |
| --------- | ----- | ----------------------------- |
| intent  | `intent.payment_intent.spend` | `(owner: VerificationKeyHash)` |
| wallet  | `wallet.wallet.mint`          | `(owner, intent_script_hash)` |
| funds   | `funds.funds.spend`           | `(owner, wallet_script_hash)` |

The parameter chain is intent → wallet → funds. Build them in that order
so each hash is available for the next.

## Scenario

`run_scenario()` exercises the happy path:

1. **Fund** owner from the shared yaci test mnemonic (account 0).
2. **add_funds** — owner deposits ADA at the funds script with a placeholder
   datum.
3. **create_intent** — owner mints an `INTENT_MARKER` NFT (wallet policy,
   `Mint` redeemer) and locks it at the intent script with a `PaymentIntent`
   datum (recipient, amount, opaque data).
4. **execute_intent** — single tx that:
   - spends the funds UTxO (`funds.ExecuteTx`),
   - spends the intent UTxO (`intent.spend`),
   - burns the marker (`wallet.Burn`),
   - pays exactly `lovelace_amt` to the recipient.
5. **add_funds** + **withdraw_funds** — refill and then exercise the
   owner-only `funds.Withdraw` escape hatch.

## Run

```bash
pip install -r requirements.txt
python simple_wallet.py
```

Requires yaci-devkit listening on `http://localhost:8080`.
