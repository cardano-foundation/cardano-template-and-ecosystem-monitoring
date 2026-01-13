# Constant Product AMM (Aiken)

This on-chain validator implements a constant product automated market maker (AMM) on Cardano. The validator manages a liquidity pool for a token pair using the constant product formula (x * y = k) to enable trustless token swaps and liquidity provision.

## Structure

- `validators/amm.ak` implements the AMM validator with swap, liquidity addition, and liquidity removal operations.
- The datum is `PoolDatum { reserve_a, reserve_b, lp_supply }` tracking pool reserves and LP token supply.
- Redeemers cover `Swap`, `AddLiquidity`, and `RemoveLiquidity` actions.
- `lib/utils.ak` provides helper functions for address lookups.

## Build

```sh
aiken build
```

## Test

```sh
aiken check
```

## Design Notes

- The validator uses the constant product formula: `(x + dx) * (y - dy) = x * y` where fees are applied to input amounts.
- Swap operations validate that output amounts meet minimum requirements (slippage protection).
- Liquidity operations mint/burn LP tokens proportional to deposits/withdrawals.
- Initial liquidity sets the LP token supply equal to the initial reserve_a (simplified model).
- Subsequent liquidity additions calculate LP tokens based on proportional contribution.

## Example Datum

```json
{
  "reserve_a": 1000000,
  "reserve_b": 2000000,
  "lp_supply": 1000000
}
```

## Validator Parameters

The validator is parameterized by:
- `token_a_policy`: Policy ID of token A
- `token_a_name`: Asset name of token A
- `token_b_policy`: Policy ID of token B
- `token_b_name`: Asset name of token B
- `lp_policy`: Policy ID for LP tokens
- `fee_bps`: Fee in basis points (e.g., 30 = 0.3%)
