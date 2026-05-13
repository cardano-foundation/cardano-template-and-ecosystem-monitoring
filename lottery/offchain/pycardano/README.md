# lottery — PyCardano Scenario

PyCardano 0.19.2 implementation of the commit-reveal 2-player `lottery`
validators.

## Scenario

Two on-chain validators are involved:

- `lottery_creator.lottery_creator.mint` — parameterised by `_game_index: Int`.
  Mints/burns the `LOTTERY_TOKEN` whose presence anchors the lottery state UTxO.
- `lottery.lottery.spend` — parameterised by `(policy_id: PolicyId, _game_index: Int)`.
  Handles `Reveal1`, `Reveal2`, `Timeout1`, `Timeout2`, `Settle`.

Happy-path scenario:

1. **CREATE** — coordinator + both players co-sign; mints 1 `LOTTERY_TOKEN`
   into a script UTxO with the initial `LotteryDatum` (`n1 = n2 = ""`).
2. **REVEAL1** — player 1 publishes `SECRET1 = "3"`; datum updated.
3. **REVEAL2** — player 2 publishes `SECRET2 = "4"`; datum updated.
4. **SETTLE** — burns the token and pays the bet to the winner determined by
   parity of `(int.from_utf8(n1) + int.from_utf8(n2))`. Here `(3+4) % 2 == 1`
   so **player 1** wins.

Coordinator, player 1, and player 2 are three fresh wallets funded from
account 0.

## Prerequisites

- Python 3.11+
- [yaci-devkit](https://github.com/bloxbean/yaci-devkit) running locally on
  port 8080.

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python lottery.py
```

## Implementation notes

- Secrets are raw UTF-8 byte strings (e.g. `b"3"`) because the validator parses
  them with `int.from_utf8`. Commits are `blake2b_256` of those byte strings.
- `end_reveal` is set far in the future so Reveal* aren't blocked by any time
  gate (only Timeout1/Timeout2 use it).
- Parameters are applied via `uplc.tools.apply` (no `apply_params_to_script`
  in pycardano 0.19.2). `policy_id` is passed as `PlutusByteString` of the
  28-byte creator script hash.
- The Settle output pays exactly `BET_LOVELACE` to the winner; the lottery
  token is burned in the same tx via the creator mint policy with the `Burn`
  redeemer.
