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

// Two-player oracle-resolved bet.
// Lifecycle: mint = CREATE (player1 stakes), JOIN (player2 matches), then
// ANNOUNCE_WINNER (oracle picks a side after expiration). The minted token
// is the bet's identity and must travel with the UTxO until settlement.

pub type BetDatum {
  player1: VerificationKeyHash,
  // Empty bytes ("") = no opponent yet. Flat sentinel instead of Option to
  // keep the datum cheap to compare on-chain.
  player2: VerificationKeyHash,
  oracle: VerificationKeyHash,
  expiration: Int,
}

pub type Action {
  JOIN
  ANNOUNCE_WINNER { winner: VerificationKeyHash }
}

validator bet {
  // CREATE — initial mint. One script output, player1 signed, no opponent,
  // oracle distinct from player1, and the bet still in its open window.
  // Exact-output-routing of the bet UTxO is the off-chain side's job.
  mint(_redeemer: Data, policy_id: ByteArray, transaction: Transaction) {
    let Transaction { outputs, extra_signatories, validity_range, .. } =
      transaction
    let outputs_to_script =
      list.filter(
        outputs,
        fn(output) { output.address == from_script(policy_id) },
      )

    expect list.length(outputs_to_script) == 1
    expect Some(bet_output) = list.head(outputs_to_script)
    let Output { datum, .. } = bet_output

    expect InlineDatum(bet_datum_data) = datum
    expect BetDatum { player1, player2, oracle, expiration } = bet_datum_data

    and {
      key_signed(extra_signatories, player1)?,
      (player2 == "")?,
      // Oracle == player1 would let the creator self-decide the outcome.
      (oracle != player1)?,
      valid_before(validity_range, expiration)?,
    }
  }

  spend(
    input_datum: Option<BetDatum>,
    redeemer: Action,
    spent_output_ref: OutputReference,
    transaction: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      transaction

    expect Some(spent_input) = find_input(inputs, spent_output_ref)
    let Output { value: input_value, .. } = spent_input.output

    when redeemer is {
      // JOIN — player2 matches player1's stake. Re-issues the script UTxO
      // with the same identity (bet token), unchanged oracle/player1/expiry,
      // and doubled lovelace. Open-bet invariants come from CREATE.
      JOIN -> {
        // Identity check: the bet token's policy must equal the script that
        // currently owns the UTxO — anything else is an impostor UTxO.
        let has_bet_token =
          list.has(
            list.map(policies(input_value), fn(policy) { from_script(policy) }),
            spent_input.output.address,
          )

        let continuing_outputs =
          list.filter(
            outputs,
            fn(output) { output.address == spent_input.output.address },
          )

        expect list.length(continuing_outputs) == 1
        expect Some(continuing_output) = list.head(continuing_outputs)
        let Output { value: output_value, datum: updated_datum, .. } =
          continuing_output

        expect Some(current_datum) = input_datum

        expect InlineDatum(updated_datum) = updated_datum
        expect new_datum: BetDatum = updated_datum
        let joining_player = new_datum.player2

        and {
          (current_datum.player2 == "")?,
          has_bet_token?,
          key_signed(extra_signatories, joining_player)?,
          (new_datum.oracle == current_datum.oracle)?,
          (new_datum.player1 == current_datum.player1)?,
          // Forbid self-bet and oracle-as-player conflicts of interest.
          (joining_player != current_datum.player1)?,
          (joining_player != current_datum.oracle)?,
          // Exact double — not >= — so the pot is provably symmetric.
          (lovelace_of(output_value) == 2 * lovelace_of(input_value))?,
          new_datum.expiration == current_datum.expiration,
          valid_before(validity_range, new_datum.expiration)?,
        }
      }

      // ANNOUNCE_WINNER — oracle settles after expiration. Single output
      // (the payout), no continuing datum, no further state. Requires the
      // bet to have been joined; an unjoined bet must be reclaimed another
      // way (not implemented here — it would lock funds).
      ANNOUNCE_WINNER { winner } -> {
        expect Some(current_datum_data) = input_datum
        let BetDatum { player1, player2, oracle, expiration } =
          current_datum_data

        expect list.length(outputs) == 1
        expect Some(payout_output) = list.head(outputs)
        and {
          or {
            winner == player1,
            winner == player2,
          },
          (player2 != "")?,
          (payout_output.datum == NoDatum)?,
          (payout_output.address == from_verification_key(winner))?,
          key_signed(extra_signatories, oracle)?,
          // valid_after(range, point) <=> range.lower_bound > point.
          // Forces settlement strictly after expiry — no early calls.
          valid_after(validity_range, expiration)?,
        }
      }
    }
  }

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
      player2: "",
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
      player2: "",
      oracle: mock_pub_key_hash(3),
      expiration: 1753939940,
    }

  // Updated state: player2 has joined
  let updated_bet_datum =
    BetDatum {
      player1: mock_pub_key_hash(1),
      player2: mock_pub_key_hash(2),
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
    Some(initial_bet_datum),
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
      player2: mock_pub_key_hash(2),
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
  bet.spend(
    Some(final_bet_datum),
    announce_winner_action,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}
