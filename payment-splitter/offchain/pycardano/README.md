# payment-splitter — PyCardano Scenario

PyCardano 0.19.2 implementation of the payment-splitter validator
(parameterised by a list of payee VKHs).

## Scenario

1. **LOCK** — payer (account 0, also payee[0]) locks 50 ADA at the splitter
   script with an inline datum.
2. **PAYOUT** — spending tx distributes equal lovelace shares to all 5 payees
   (accounts 0..4). The validator enforces (a) outputs go only to payees and
   (b) all payees receive equal net amounts.

The payer must itself be a payee — otherwise its change credential breaks the
"no additional payees" rule.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python payment_splitter.py
```
