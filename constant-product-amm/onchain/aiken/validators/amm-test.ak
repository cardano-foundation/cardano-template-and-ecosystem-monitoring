use aiken/primitive/bytearray.{from_string}
use cardano/address.{Address, from_script}
use cardano/assets.{add, from_lovelace}
use cardano/transaction.{
  InlineDatum, Input, Output, Transaction, placeholder,
}
use amm.{Action, PoolDatum}
use mocktail/virgin_key_hash.{mock_policy_id}
use mocktail/virgin_output_reference.{mock_utxo_ref}

// Test parameters
fn token_a_policy() -> ByteArray {
  mock_policy_id(0)
}

fn token_a_name() -> ByteArray {
  from_string(@"TokenA")
}

fn token_b_policy() -> ByteArray {
  mock_policy_id(1)
}

fn token_b_name() -> ByteArray {
  from_string(@"TokenB")
}

fn lp_policy() -> ByteArray {
  mock_policy_id(2)
}

fn fee_bps() -> Int {
  30 // 0.3%
}

fn pool_address() -> Address {
  from_script(mock_policy_id(3))
}

fn initial_pool_datum() -> PoolDatum {
  PoolDatum {
    reserve_a: 1_000_000,
    reserve_b: 2_000_000,
    lp_supply: 1_000_000,
  }
}

// Test: Successful swap A for B
test should_swap_token_a_for_b() {
  let old_datum = initial_pool_datum()
  let input_amount = 100_000
  let input_after_fee = (input_amount * (10000 - fee_bps())) / 10000
  let expected_output = (input_after_fee * old_datum.reserve_b) / (old_datum.reserve_a + input_after_fee)
  let min_output = expected_output - 1000 // Allow some slippage

  let new_datum = PoolDatum {
    reserve_a: old_datum.reserve_a + input_amount,
    reserve_b: old_datum.reserve_b - expected_output,
    lp_supply: old_datum.lp_supply,
  }

  let spent_input = Input {
    output: Output {
      address: pool_address(),
      value: from_lovelace(2_000_000)
        |> assets.add(token_a_policy(), token_a_name(), old_datum.reserve_a)
        |> assets.add(token_b_policy(), token_b_name(), old_datum.reserve_b),
      datum: InlineDatum(old_datum),
      reference_script: None,
    },
    output_reference: mock_utxo_ref(0, 0),
  }

  let pool_output = Output {
    address: pool_address(),
    value: from_lovelace(2_000_000)
      |> assets.add(token_a_policy(), token_a_name(), new_datum.reserve_a)
      |> assets.add(token_b_policy(), token_b_name(), new_datum.reserve_b),
    datum: InlineDatum(new_datum),
    reference_script: None,
  }

  let transaction = Transaction {
    ..placeholder,
    inputs: [spent_input],
    outputs: [pool_output],
    mint: from_lovelace(0),
  }

  amm.amm.spend(
    token_a_policy(),
    token_a_name(),
    token_b_policy(),
    token_b_name(),
    lp_policy(),
    fee_bps(),
    Some(old_datum),
    Action.Swap { min_output },
    mock_utxo_ref(0, 0),
    transaction,
  )
}

// Test: Swap fails if output is less than minimum
test should_not_swap_below_minimum_output() fail {
  let old_datum = initial_pool_datum()
  let input_amount = 100_000
  let input_after_fee = (input_amount * (10000 - fee_bps())) / 10000
  let expected_output = (input_after_fee * old_datum.reserve_b) / (old_datum.reserve_a + input_after_fee)
  let min_output = expected_output + 10_000 // Too high minimum

  let new_datum = PoolDatum {
    reserve_a: old_datum.reserve_a + input_amount,
    reserve_b: old_datum.reserve_b - expected_output,
    lp_supply: old_datum.lp_supply,
  }

  let spent_input = Input {
    output: Output {
      address: pool_address(),
      value: from_lovelace(2_000_000)
        |> assets.add(token_a_policy(), token_a_name(), old_datum.reserve_a)
        |> assets.add(token_b_policy(), token_b_name(), old_datum.reserve_b),
      datum: InlineDatum(old_datum),
      reference_script: None,
    },
    output_reference: mock_utxo_ref(0, 0),
  }

  let pool_output = Output {
    address: pool_address(),
    value: from_lovelace(2_000_000)
      |> assets.add(token_a_policy(), token_a_name(), new_datum.reserve_a)
      |> assets.add(token_b_policy(), token_b_name(), new_datum.reserve_b),
    datum: InlineDatum(new_datum),
    reference_script: None,
  }

  let transaction = Transaction {
    ..placeholder,
    inputs: [spent_input],
    outputs: [pool_output],
    mint: from_lovelace(0),
  }

  amm.amm.spend(
    token_a_policy(),
    token_a_name(),
    token_b_policy(),
    token_b_name(),
    lp_policy(),
    fee_bps(),
    Some(old_datum),
    Action.Swap { min_output },
    mock_utxo_ref(0, 0),
    transaction,
  )
}

// Test: Successful swap B for A
test should_swap_token_b_for_a() {
  let old_datum = initial_pool_datum()
  let input_amount = 200_000
  let input_after_fee = (input_amount * (10000 - fee_bps())) / 10000
  let expected_output = (input_after_fee * old_datum.reserve_a) / (old_datum.reserve_b + input_after_fee)
  let min_output = expected_output - 1000

  let new_datum = PoolDatum {
    reserve_a: old_datum.reserve_a - expected_output,
    reserve_b: old_datum.reserve_b + input_amount,
    lp_supply: old_datum.lp_supply,
  }

  let spent_input = Input {
    output: Output {
      address: pool_address(),
      value: from_lovelace(2_000_000)
        |> assets.add(token_a_policy(), token_a_name(), old_datum.reserve_a)
        |> assets.add(token_b_policy(), token_b_name(), old_datum.reserve_b),
      datum: InlineDatum(old_datum),
      reference_script: None,
    },
    output_reference: mock_utxo_ref(0, 0),
  }

  let pool_output = Output {
    address: pool_address(),
    value: from_lovelace(2_000_000)
      |> assets.add(token_a_policy(), token_a_name(), new_datum.reserve_a)
      |> assets.add(token_b_policy(), token_b_name(), new_datum.reserve_b),
    datum: InlineDatum(new_datum),
    reference_script: None,
  }

  let transaction = Transaction {
    ..placeholder,
    inputs: [spent_input],
    outputs: [pool_output],
    mint: from_lovelace(0),
  }

  amm.amm.spend(
    token_a_policy(),
    token_a_name(),
    token_b_policy(),
    token_b_name(),
    lp_policy(),
    fee_bps(),
    Some(old_datum),
    Action.Swap { min_output },
    mock_utxo_ref(0, 0),
    transaction,
  )
}

// Test: Successful initial liquidity addition
test should_add_initial_liquidity() {
  let old_datum = PoolDatum {
    reserve_a: 0,
    reserve_b: 0,
    lp_supply: 0,
  }

  let reserve_a = 1_000_000
  let reserve_b = 2_000_000
  let initial_lp = reserve_a

  let new_datum = PoolDatum {
    reserve_a,
    reserve_b,
    lp_supply: initial_lp,
  }

  let spent_input = Input {
    output: Output {
      address: pool_address(),
      value: from_lovelace(2_000_000), // Minimum ADA
      datum: InlineDatum(old_datum),
      reference_script: None,
    },
    output_reference: mock_utxo_ref(0, 0),
  }

  let pool_output = Output {
    address: pool_address(),
    value: from_lovelace(2_000_000)
      |> assets.add(token_a_policy(), token_a_name(), new_datum.reserve_a)
      |> assets.add(token_b_policy(), token_b_name(), new_datum.reserve_b),
    datum: InlineDatum(new_datum),
    reference_script: None,
  }

  let transaction = Transaction {
    ..placeholder,
    inputs: [spent_input],
    outputs: [pool_output],
    mint: from_lovelace(0)
      |> assets.add(lp_policy(), from_string(@"LP"), initial_lp),
  }

  amm.amm.spend(
    token_a_policy(),
    token_a_name(),
    token_b_policy(),
    token_b_name(),
    lp_policy(),
    fee_bps(),
    Some(old_datum),
    Action.AddLiquidity,
    mock_utxo_ref(0, 0),
    transaction,
  )
}

// Test: Successful subsequent liquidity addition
test should_add_subsequent_liquidity() {
  let old_datum = initial_pool_datum()
  let token_a_delta = 100_000
  let token_b_delta = 200_000
  let lp_minted = (token_a_delta * old_datum.lp_supply) / old_datum.reserve_a

  let new_datum = PoolDatum {
    reserve_a: old_datum.reserve_a + token_a_delta,
    reserve_b: old_datum.reserve_b + token_b_delta,
    lp_supply: old_datum.lp_supply + lp_minted,
  }

  let spent_input = Input {
    output: Output {
      address: pool_address(),
      value: from_lovelace(2_000_000)
        |> assets.add(token_a_policy(), token_a_name(), old_datum.reserve_a)
        |> assets.add(token_b_policy(), token_b_name(), old_datum.reserve_b),
      datum: InlineDatum(old_datum),
      reference_script: None,
    },
    output_reference: mock_utxo_ref(0, 0),
  }

  let pool_output = Output {
    address: pool_address(),
    value: from_lovelace(2_000_000)
      |> assets.add(token_a_policy(), token_a_name(), new_datum.reserve_a)
      |> assets.add(token_b_policy(), token_b_name(), new_datum.reserve_b),
    datum: InlineDatum(new_datum),
    reference_script: None,
  }

  let transaction = Transaction {
    ..placeholder,
    inputs: [spent_input],
    outputs: [pool_output],
    mint: from_lovelace(0)
      |> assets.add(lp_policy(), from_string(@"LP"), lp_minted),
  }

  amm.amm.spend(
    token_a_policy(),
    token_a_name(),
    token_b_policy(),
    token_b_name(),
    lp_policy(),
    fee_bps(),
    Some(old_datum),
    Action.AddLiquidity,
    mock_utxo_ref(0, 0),
    transaction,
  )
}

// Test: Successful liquidity removal
test should_remove_liquidity() {
  let old_datum = initial_pool_datum()
  let lp_burned = 100_000
  let token_a_output = (lp_burned * old_datum.reserve_a) / old_datum.lp_supply
  let token_b_output = (lp_burned * old_datum.reserve_b) / old_datum.lp_supply

  let new_datum = PoolDatum {
    reserve_a: old_datum.reserve_a - token_a_output,
    reserve_b: old_datum.reserve_b - token_b_output,
    lp_supply: old_datum.lp_supply - lp_burned,
  }

  let spent_input = Input {
    output: Output {
      address: pool_address(),
      value: from_lovelace(2_000_000)
        |> assets.add(token_a_policy(), token_a_name(), old_datum.reserve_a)
        |> assets.add(token_b_policy(), token_b_name(), old_datum.reserve_b),
      datum: InlineDatum(old_datum),
      reference_script: None,
    },
    output_reference: mock_utxo_ref(0, 0),
  }

  let pool_output = Output {
    address: pool_address(),
    value: from_lovelace(2_000_000)
      |> assets.add(token_a_policy(), token_a_name(), new_datum.reserve_a)
      |> assets.add(token_b_policy(), token_b_name(), new_datum.reserve_b),
    datum: InlineDatum(new_datum),
    reference_script: None,
  }

  // When removing liquidity, LP tokens are burned (negative mint)
  let transaction = Transaction {
    ..placeholder,
    inputs: [spent_input],
    outputs: [pool_output],
    mint: from_lovelace(0)
      |> assets.add(lp_policy(), from_string(@"LP"), -lp_burned),
  }

  amm.amm.spend(
    token_a_policy(),
    token_a_name(),
    token_b_policy(),
    token_b_name(),
    lp_policy(),
    fee_bps(),
    Some(old_datum),
    Action.RemoveLiquidity,
    mock_utxo_ref(0, 0),
    transaction,
  )
}

// Test: Remove liquidity fails if LP supply doesn't match
test should_not_remove_liquidity_wrong_lp_supply() fail {
  let old_datum = initial_pool_datum()
  let lp_burned = 100_000
  let token_a_output = (lp_burned * old_datum.reserve_a) / old_datum.lp_supply
  let token_b_output = (lp_burned * old_datum.reserve_b) / old_datum.lp_supply

  // Wrong LP supply in new datum
  let new_datum = PoolDatum {
    reserve_a: old_datum.reserve_a - token_a_output,
    reserve_b: old_datum.reserve_b - token_b_output,
    lp_supply: old_datum.lp_supply, // Should be lp_supply - lp_burned
  }

  let spent_input = Input {
    output: Output {
      address: pool_address(),
      value: from_lovelace(2_000_000)
        |> assets.add(token_a_policy(), token_a_name(), old_datum.reserve_a)
        |> assets.add(token_b_policy(), token_b_name(), old_datum.reserve_b),
      datum: InlineDatum(old_datum),
      reference_script: None,
    },
    output_reference: mock_utxo_ref(0, 0),
  }

  let pool_output = Output {
    address: pool_address(),
    value: from_lovelace(2_000_000)
      |> assets.add(token_a_policy(), token_a_name(), new_datum.reserve_a)
      |> assets.add(token_b_policy(), token_b_name(), new_datum.reserve_b),
    datum: InlineDatum(new_datum),
    reference_script: None,
  }

  let transaction = Transaction {
    ..placeholder,
    inputs: [spent_input],
    outputs: [pool_output],
    mint: from_lovelace(0)
      |> assets.add(lp_policy(), from_string(@"LP"), -lp_burned),
  }

  amm.amm.spend(
    token_a_policy(),
    token_a_name(),
    token_b_policy(),
    token_b_name(),
    lp_policy(),
    fee_bps(),
    Some(old_datum),
    Action.RemoveLiquidity,
    mock_utxo_ref(0, 0),
    transaction,
  )
}

// Test: Swap fails if reserves don't match expected values
test should_not_swap_wrong_reserves() fail {
  let old_datum = initial_pool_datum()
  let input_amount = 100_000
  let input_after_fee = (input_amount * (10000 - fee_bps())) / 10000
  let expected_output = (input_after_fee * old_datum.reserve_b) / (old_datum.reserve_a + input_after_fee)
  let min_output = expected_output - 1000

  // Wrong reserves in new datum
  let new_datum = PoolDatum {
    reserve_a: old_datum.reserve_a + input_amount,
    reserve_b: old_datum.reserve_b - expected_output + 10_000, // Wrong amount
    lp_supply: old_datum.lp_supply,
  }

  let spent_input = Input {
    output: Output {
      address: pool_address(),
      value: from_lovelace(2_000_000)
        |> assets.add(token_a_policy(), token_a_name(), old_datum.reserve_a)
        |> assets.add(token_b_policy(), token_b_name(), old_datum.reserve_b),
      datum: InlineDatum(old_datum),
      reference_script: None,
    },
    output_reference: mock_utxo_ref(0, 0),
  }

  let pool_output = Output {
    address: pool_address(),
    value: from_lovelace(2_000_000)
      |> assets.add(token_a_policy(), token_a_name(), new_datum.reserve_a)
      |> assets.add(token_b_policy(), token_b_name(), new_datum.reserve_b),
    datum: InlineDatum(new_datum),
    reference_script: None,
  }

  let transaction = Transaction {
    ..placeholder,
    inputs: [spent_input],
    outputs: [pool_output],
    mint: from_lovelace(0),
  }

  amm.amm.spend(
    token_a_policy(),
    token_a_name(),
    token_b_policy(),
    token_b_name(),
    lp_policy(),
    fee_bps(),
    Some(old_datum),
    Action.Swap { min_output },
    mock_utxo_ref(0, 0),
    transaction,
  )
}
