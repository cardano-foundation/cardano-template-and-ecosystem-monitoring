use aiken/collection/dict
use aiken/collection/list
use aiken/option
use cardano/assets.{tokens}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input,
}
use utils.{get_output_by_address}

pub type PoolDatum {
  reserve_a: Int,
  reserve_b: Int,
  lp_supply: Int,
}

pub type Action {
  Swap { min_output: Int }
  AddLiquidity
  RemoveLiquidity
}

fn calculate_swap_output(input_amount: Int, reserve_in: Int, reserve_out: Int, fee_bps: Int) -> Int {
  // Constant product formula with fee: (x + dx * (1 - fee)) * (y - dy) = x * y
  // After fee: input_after_fee = input_amount * (10000 - fee_bps) / 10000
  // Output = (input_after_fee * reserve_out) / (reserve_in + input_after_fee)
  let input_after_fee = (input_amount * (10000 - fee_bps)) / 10000
  let numerator = input_after_fee * reserve_out
  let denominator = reserve_in + input_after_fee
  numerator / denominator
}

// Helper to get token amount from a value for a specific policy and token name
fn get_token_amount(value, policy: ByteArray, token_name: ByteArray) -> Int {
  let token_dict = tokens(value, policy)
  dict.get(token_dict, token_name) |> option.or_else(0)
}

validator amm(
  token_a_policy: ByteArray,
  token_a_name: ByteArray,
  token_b_policy: ByteArray,
  token_b_name: ByteArray,
  lp_policy: ByteArray,
  fee_bps: Int,
) {
  spend(
    _datum_opt: Option<PoolDatum>,
    redeemer: Action,
    utxo: OutputReference,
    transaction: Transaction,
  ) {
    let Transaction { inputs, outputs, mint, .. } = transaction

    expect Some(spent_input) = find_input(inputs, utxo)
    let Output { value: input_value, address: pool_address, datum: input_datum, .. } =
      spent_input.output

    expect InlineDatum(input_datum_data) = input_datum
    expect PoolDatum { reserve_a: old_reserve_a, reserve_b: old_reserve_b, lp_supply: old_lp_supply } =
      input_datum_data

    let pool_output_opt = get_output_by_address(outputs, pool_address)
    expect Some(pool_output) = pool_output_opt
    let Output { value: output_value, datum: output_datum, .. } = pool_output

    expect InlineDatum(output_datum_data) = output_datum
    expect PoolDatum { reserve_a: new_reserve_a, reserve_b: new_reserve_b, lp_supply: new_lp_supply } =
      output_datum_data

    let old_token_a = get_token_amount(input_value, token_a_policy, token_a_name)
    let old_token_b = get_token_amount(input_value, token_b_policy, token_b_name)
    let new_token_a = get_token_amount(output_value, token_a_policy, token_a_name)
    let new_token_b = get_token_amount(output_value, token_b_policy, token_b_name)

    let token_a_delta = new_token_a - old_token_a
    let token_b_delta = new_token_b - old_token_b

    when redeemer is {
      Swap { min_output } -> {
        // Swap: user provides one token, gets the other
        // Determine swap direction
        when (token_a_delta > 0 && token_b_delta < 0) is {
          // Swapping A for B
          True -> {
            let expected_output = calculate_swap_output(
              token_a_delta,
              old_reserve_a,
              old_reserve_b,
              fee_bps,
            )
            and {
              (expected_output >= min_output)?,
              (new_reserve_a == old_reserve_a + token_a_delta)?,
              (new_reserve_b == old_reserve_b - expected_output)?,
              (new_lp_supply == old_lp_supply)?,
              (-token_b_delta >= expected_output)?,
            }
          }
          False -> {
            // Swapping B for A
            when (token_b_delta > 0 && token_a_delta < 0) is {
              True -> {
                let expected_output = calculate_swap_output(
                  token_b_delta,
                  old_reserve_b,
                  old_reserve_a,
                  fee_bps,
                )
                and {
                  (expected_output >= min_output)?,
                  (new_reserve_b == old_reserve_b + token_b_delta)?,
                  (new_reserve_a == old_reserve_a - expected_output)?,
                  (new_lp_supply == old_lp_supply)?,
                  (-token_a_delta >= expected_output)?,
                }
              }
              False -> False
            }
          }
        }
      }

      AddLiquidity -> {
        // Adding liquidity: user deposits both tokens, receives LP tokens
        let lp_dict = mint |> tokens(lp_policy)
        let lp_minted = lp_dict |> dict.values() |> list.reduce(0, fn(x, acc) { x + acc })

        when (old_lp_supply == 0) is {
          // Initial liquidity: LP tokens = sqrt(reserve_a * reserve_b)
          // Simplified: use new_reserve_a as initial LP tokens
          True -> {
            let initial_lp = new_reserve_a
            and {
              (lp_minted > 0)?,
              (token_a_delta > 0)?,
              (token_b_delta > 0)?,
              (new_reserve_a == old_reserve_a + token_a_delta)?,
              (new_reserve_b == old_reserve_b + token_b_delta)?,
              (lp_minted == initial_lp)?,
              (new_lp_supply == old_lp_supply + lp_minted)?,
            }
          }
          False -> {
            // Subsequent deposits: LP tokens proportional to contribution
            let lp_from_a = (token_a_delta * old_lp_supply) / old_reserve_a
            let lp_from_b = (token_b_delta * old_lp_supply) / old_reserve_b
            and {
              (lp_minted > 0)?,
              (token_a_delta > 0)?,
              (token_b_delta > 0)?,
              (lp_from_a == lp_from_b)?,
              (lp_minted == lp_from_a)?,
              (new_reserve_a == old_reserve_a + token_a_delta)?,
              (new_reserve_b == old_reserve_b + token_b_delta)?,
              (new_lp_supply == old_lp_supply + lp_minted)?,
            }
          }
        }
      }

      RemoveLiquidity -> {
        // Removing liquidity: user burns LP tokens, receives proportional reserves
        // When tokens are burned, mint amounts are negative
        let lp_dict = mint |> tokens(lp_policy)
        let lp_burned_raw = lp_dict |> dict.values() |> list.reduce(0, fn(x, acc) { x + acc })
        // lp_burned_raw is negative when burning, so we negate it
        let lp_burned = -lp_burned_raw
        let token_a_output = (lp_burned * old_reserve_a) / old_lp_supply
        let token_b_output = (lp_burned * old_reserve_b) / old_lp_supply

        and {
          (lp_burned > 0)?,
          (lp_burned_raw < 0)?,
          (new_reserve_a == old_reserve_a - token_a_output)?,
          (new_reserve_b == old_reserve_b - token_b_output)?,
          (new_lp_supply == old_lp_supply - lp_burned)?,
          (token_a_delta == -token_a_output)?,
          (token_b_delta == -token_b_output)?,
        }
      }
    }
  }
}
