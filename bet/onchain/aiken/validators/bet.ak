use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{from_script, from_verification_key}
use cardano/assets.{from_lovelace, lovelace_of, policies}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, find_input,
  placeholder,
}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_validity_range.{valid_after, valid_before}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}
use mocktail/virgin_validity_range.{mock_interval}

/// Represents the state of a two-player betting game
/// The bet starts with player1 creating it, then player2 can join
/// The oracle decides the winner and triggers the payout
pub type BetDatum {
  /// The public key hash of the first player (bet creator)
  player1: VerificationKeyHash,
  /// The public key hash of the second player (None if no one has joined yet)
  player2: Option<VerificationKeyHash>,
  /// The public key hash of the trusted oracle who will announce the winner
  oracle: VerificationKeyHash,
  /// The expiration time of the bet (in seconds since the epoch)
  expiration: Int,
}

/// Actions that can be performed on the betting contract
pub type Action {
  /// Action for player2 to join an existing bet
  JOIN
  /// Action for the oracle to announce the winner and trigger payout
  ANNOUNCE_WINNER { winner: VerificationKeyHash }
}

/// Main betting validator
validator bet {
  /// Minting policy: Controls the creation of bet tokens
  /// This ensures proper initialization of a new bet
  mint(_redeemer: Data, policy_id: ByteArray, transaction: Transaction) {
    let Transaction { outputs, extra_signatories, validity_range, .. } =
      transaction
    // Find all outputs going to this script's address
    let outputs_to_script =
      list.filter(
        outputs,
        fn(output) { output.address == from_script(policy_id) },
      )

    // Ensure exactly one output goes to the script (the bet UTXO)
    expect list.length(outputs_to_script) == 1
    expect Some(bet_output) = list.head(outputs_to_script)
    let Output { datum, .. } = bet_output

    // Extract and validate the bet datum
    expect InlineDatum(bet_datum_data) = datum
    expect BetDatum { player1, player2, oracle, expiration } = bet_datum_data

    // Validation rules for bet initialization:
    and {
      // 1. Player1 must sign the transaction (they're creating the bet)
      key_signed(extra_signatories, player1),
      // 2. Player2 must be None (no one has joined yet)
      player2 == None,
      // 3. Oracle cannot be the same as player1 (conflict of interest)
      oracle != player1,
      // 4. The bet must have a valid expiration time (after the current time)
      valid_before(validity_range, expiration),
    }
  }

  /// Spending validator: Controls how the bet UTXO can be spent
  /// Handles both JOIN and ANNOUNCE_WINNER actions
  spend(
    updated_datum: Option<BetDatum>,
    redeemer: Action,
    spent_output_ref: OutputReference,
    transaction: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      transaction

    // Find the input being spent
    expect Some(spent_input) = find_input(inputs, spent_output_ref)
    let Output { value: input_value, datum: input_datum, .. } =
      spent_input.output

    when redeemer is {
      // Handle player2 joining the bet
      JOIN -> {
        // Verify the input contains the bet token (proves it's a valid bet UTXO)
        let has_bet_token =
          list.has(
            list.map(policies(input_value), fn(policy) { from_script(policy) }),
            spent_input.output.address,
          )

        // Find the continuing output (bet UTXO with updated datum)
        let continuing_outputs =
          list.filter(
            outputs,
            fn(output) { output.address == spent_input.output.address },
          )

        // Ensure exactly one continuing output
        expect list.length(continuing_outputs) == 1
        expect Some(continuing_output) = list.head(continuing_outputs)
        let Output { value: output_value, .. } = continuing_output

        // Extract the current bet state
        expect InlineDatum(current_datum_data) = input_datum
        expect current_datum: BetDatum = current_datum_data

        // Extract the updated bet state
        expect Some(new_datum) = updated_datum
        expect Some(joining_player) = new_datum.player2

        // Validation rules for joining:
        and {
          // 1. Current bet must not have a player2 yet
          (current_datum.player2 == None)?,
          // 2. Input must contain the bet token
          has_bet_token?,
          // 3. Player2 must sign the transaction
          key_signed(extra_signatories, joining_player)?,
          // 4. Oracle must remain unchanged
          (new_datum.oracle == current_datum.oracle)?,
          // 5. Player1 must remain unchanged
          (new_datum.player1 == current_datum.player1)?,
          // 6. Player2 cannot be the same as player1
          (joining_player != current_datum.player1)?,
          // 7. Player2 cannot be the same as oracle
          (joining_player != current_datum.oracle)?,
          // 8. The bet amount must double (player2 matches player1's bet)
          (lovelace_of(output_value) == 2 * lovelace_of(input_value))?,
          // 9. The updated datum must have the same expiration as the current one
          new_datum.expiration == current_datum.expiration,
          // 10. Joining must happen before the bet expiration
          valid_before(validity_range, new_datum.expiration)?,
        }
      }
      // Handle oracle announcing the winner
      ANNOUNCE_WINNER { winner } -> {
        // Extract the current bet state
        expect InlineDatum(current_datum_data) = input_datum
        expect BetDatum { player1, player2, oracle, expiration } =
          current_datum_data

        // Ensure there's exactly one output (the payout to winner)
        expect list.length(outputs) == 1
        expect Some(payout_output) = list.head(outputs)

        // Validation rules for announcing winner:
        and {
          // 1. Winner must be either player1 or player2
          or {
            winner == player1,
            Some(winner) == player2,
          },
          // 2. Both players must have joined (player2 is not None)
          (player2 != None)?,
          // 3. No continuing datum (bet is being closed)
          (updated_datum == None)?,
          // 4. Payout goes to the winner's address
          (payout_output.address == from_verification_key(winner))?,
          // 5. Oracle must sign the transaction
          key_signed(extra_signatories, oracle)?,
          // 6. The bet must have been expired (no future bets allowed) before announcing
          valid_after(validity_range, expiration)?,
        }
      }
    }
  }

  /// Catch-all for any other redeemer - always fails
  /// This ensures the contract can only be used as intended
  else(_) {
    fail
  }
}

// ============= TESTS =============

/// Test: Verify that a bet can be properly initialized
test should_init_the_bet() {
  // Create test datum for a new bet
  let initial_bet_datum =
    BetDatum {
      player1: mock_pub_key_hash(1),
      player2: None,
      // No second player yet
      oracle: mock_pub_key_hash(3),
      expiration: 1753939940,
    }
  // 31th of July 2025 
  // Create test transaction that mints a bet token
  let test_transaction =
    Transaction {
      ..placeholder,
      outputs: [
        Output {
          address: from_script(mock_policy_id(1)),
          value: from_lovelace(3000000)
            // 3 ADA initial bet
            |> assets.add(mock_policy_id(1), "lucky_number_slevin", 1),
          datum: InlineDatum(initial_bet_datum),
          reference_script: None,
        },
      ],
      extra_signatories: [
        // Player1 signs to create the bet
        mock_pub_key_hash(1),
      ],
      validity_range: // 20th of July 2025 - for 5 minutes
      mock_interval(Some(1752989540), Some(1752990020)),
    }

  bet.mint(NoDatum, mock_policy_id(1), test_transaction)
}

/// Test: Verify that player2 can join an existing bet
test join_the_bet() {
  // Initial state: bet created by player1
  let initial_bet_datum =
    BetDatum {
      player1: mock_pub_key_hash(1),
      player2: None,
      oracle: mock_pub_key_hash(3),
      expiration: 1753939940,
    }

  // Updated state: player2 has joined
  let updated_bet_datum =
    BetDatum {
      player1: mock_pub_key_hash(1),
      player2: Some(mock_pub_key_hash(2)),
      oracle: mock_pub_key_hash(3),
      expiration: 1753939940,
    }

  // Create test transaction where player2 joins
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(3000000)
              // Original 3 ADA bet
              |> assets.add(mock_policy_id(1), "lucky_number_slevin", 1),
            datum: InlineDatum(initial_bet_datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          address: from_script(mock_policy_id(1)),
          value: from_lovelace(6000000)
            // Doubled to 6 ADA
            |> assets.add(mock_policy_id(1), "lucky_number_slevin", 1),
          datum: InlineDatum(updated_bet_datum),
          reference_script: None,
        },
      ],
      extra_signatories: [
        // Player2 signs to join the bet
        mock_pub_key_hash(2),
      ],
      validity_range: // 22th of July 2025 - for 5 minutes
      mock_interval(Some(1753162820), Some(1753163120)),
    }

  let join_action: Action = JOIN

  bet.spend(
    Some(updated_bet_datum),
    join_action,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

/// Test: Verify that the oracle can announce winner and trigger payout
test payout_winner() {
  // Final bet state with both players
  let final_bet_datum =
    BetDatum {
      player1: mock_pub_key_hash(1),
      player2: Some(mock_pub_key_hash(2)),
      oracle: mock_pub_key_hash(3),
      expiration: 1753939940,
    }

  // Create test transaction where oracle announces player2 as winner
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(6000000)
              // Total pot: 6 ADA
              |> assets.add(mock_policy_id(1), "lucky_number_slevin", 1),
            datum: InlineDatum(final_bet_datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          // Payout goes to player2's address
          address: from_verification_key(mock_pub_key_hash(2)),
          value: from_lovelace(6000000)
            // Winner takes all
            |> assets.add(mock_policy_id(1), "lucky_number_slevin", 1),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [
        // Oracle signs to announce the winner
        mock_pub_key_hash(3),
      ],
      validity_range: // 1st of August 2025 - for 5 minutes
      mock_interval(Some(1754027120), Some(1754027420)),
    }
  let announce_winner_action: Action =
    ANNOUNCE_WINNER { winner: mock_pub_key_hash(2) }
  bet.spend(None, announce_winner_action, mock_utxo_ref(1, 0), test_transaction)
}
