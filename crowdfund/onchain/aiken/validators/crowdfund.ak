use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{from_script}
use cardano/assets.{from_lovelace}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input,
  placeholder,
}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_validity_range.{valid_after}
use mocktail/virgin_address.{mock_pub_key_address}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}
use mocktail/virgin_validity_range.{mock_interval}

pub type Action {
  DONATE
  WITHDRAW
  RECLAIM
}

pub type CrowdfundDatum {
  wallets: Pairs<VerificationKeyHash, Int>,
}

validator crowdfund(
  beneficiary: VerificationKeyHash,
  goal: Int,
  deadline: Int,
) {
  spend(
    datum_opt: Option<CrowdfundDatum>,
    redeemer: Action,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      self
    when datum_opt is {
      Some(datum) -> {
        expect Some(spent_utxo) = find_input(inputs, utxo)
        when redeemer is {
          WITHDRAW -> and {
              // Check if the deadline is exceeded
              valid_after(validity_range, deadline),
              // Check if the goal is reached
              assets.lovelace_of(spent_utxo.output.value) >= goal,
              // Check if the beneficiary signed the transaction
              key_signed(extra_signatories, beneficiary),
            }
          RECLAIM -> {
            // Allowing to extract the total donated amount of multiple donators
            let donated_amount =
              dict.from_pairs(datum.wallets)
                |> dict.filter(fn(k, _v) { list.has(extra_signatories, k) })
                |> dict.values()
                |> list.reduce(0, fn(x, acc) { x + acc })
            let lovelace_in_script = assets.lovelace_of(spent_utxo.output.value)
            when donated_amount == lovelace_in_script is {
              // Withdrawing all of the funds, there will be no payback
              True -> and {
                  // Check if the deadline is exceeded
                  valid_after(validity_range, deadline),
                  // Check if the goal is reached
                  lovelace_in_script <= goal,
                }
              // Check if the beneficiary signed the transaction
              False -> {
                let script_output_opt =
                  list.find(
                    outputs,
                    fn(output) { output.address == spent_utxo.output.address },
                  )
                expect Some(script_output) = script_output_opt
                expect InlineDatum(current_datum_data) = script_output.datum
                expect Some(CrowdfundDatum { wallets }) = current_datum_data
                let donors_removed =
                  list.any(
                    extra_signatories,
                    fn(signatory) {
                      dict.has_key(dict.from_pairs(wallets), signatory)
                    },
                  )
                and {
                  donors_removed == False,
                  lovelace_in_script <= assets.lovelace_of(script_output.value) + donated_amount,
                  // Check if the deadline is exceeded
                  valid_after(validity_range, deadline),
                  // Check if the goal is reached
                  assets.lovelace_of(spent_utxo.output.value) < goal,
                }
              }
            }
          }
          DONATE -> {
            let script_output_opt =
              list.find(
                outputs,
                fn(output) { output.address == spent_utxo.output.address },
              )
            expect Some(script_output) = script_output_opt
            expect InlineDatum(current_datum_data) = script_output.datum
            expect CrowdfundDatum { wallets } = current_datum_data
            let donated_amount =
              dict.from_pairs(wallets)
                |> dict.values()
                |> list.reduce(0, fn(x, acc) { x + acc })
            and {
              // There is now more funds in the script UTxO than before
              assets.lovelace_of(spent_utxo.output.value) < assets.lovelace_of(
                script_output.value,
              ),
              // The map of wallets is updated with the new donation
              donated_amount == assets.lovelace_of(script_output.value),
            }
          }
        }
      }
      // Unlocking a UTxO without a datum is allowed to avoid locking indefinitely
      None -> True
    }
  }

  else(_) {
    fail
  }
}

// ============= TESTS =============

test should_not_spend_reclaim_claiming_to_much() fail {
  let crowdfund_datum_spend =
    Some(
      CrowdfundDatum {
        wallets: [
          Pair(mock_pub_key_hash(0), 1000),
          Pair(mock_pub_key_hash(1), 1000),
        ],
      },
    )
  let crowdfund_datum =
    Some(CrowdfundDatum { wallets: [Pair(mock_pub_key_hash(0), 1000)] })
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(2000),
            datum: InlineDatum(crowdfund_datum_spend),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          address: from_script(mock_policy_id(1)),
          value: from_lovelace(999),
          datum: InlineDatum(crowdfund_datum),
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1754027120), Some(1754027120)),
    }

  crowdfund.spend(
    mock_pub_key_hash(0),
    2000,
    1753162920,
    crowdfund_datum,
    RECLAIM,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_not_spend_reclaim_goal_reached() fail {
  let crowdfund_datum_spend =
    Some(
      CrowdfundDatum {
        wallets: [
          Pair(mock_pub_key_hash(0), 1000),
          Pair(mock_pub_key_hash(1), 1000),
        ],
      },
    )
  let crowdfund_datum =
    Some(CrowdfundDatum { wallets: [Pair(mock_pub_key_hash(0), 1000)] })
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(2000),
            datum: InlineDatum(crowdfund_datum_spend),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          address: from_script(mock_policy_id(1)),
          value: from_lovelace(1000),
          datum: InlineDatum(crowdfund_datum),
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1754027120), Some(1754027120)),
    }

  crowdfund.spend(
    mock_pub_key_hash(0),
    2000,
    1753162920,
    crowdfund_datum_spend,
    RECLAIM,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_not_spend_reclaim_not_a_donor() fail {
  let crowdfund_datum_spend =
    Some(
      CrowdfundDatum {
        wallets: [
          Pair(mock_pub_key_hash(0), 1000),
          Pair(mock_pub_key_hash(1), 1000),
        ],
      },
    )
  let crowdfund_datum =
    Some(CrowdfundDatum { wallets: [Pair(mock_pub_key_hash(0), 1000)] })
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(2000),
            datum: InlineDatum(crowdfund_datum_spend),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          address: from_script(mock_policy_id(1)),
          value: from_lovelace(1000),
          datum: InlineDatum(crowdfund_datum),
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(2)],
      validity_range: mock_interval(Some(1754027120), Some(1754027120)),
    }

  crowdfund.spend(
    mock_pub_key_hash(0),
    4000,
    1753162920,
    crowdfund_datum_spend,
    RECLAIM,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_spend_reclaim() {
  let crowdfund_datum_spend =
    Some(
      CrowdfundDatum {
        wallets: [
          Pair(mock_pub_key_hash(0), 1000),
          Pair(mock_pub_key_hash(1), 1000),
        ],
      },
    )
  let crowdfund_datum =
    Some(CrowdfundDatum { wallets: [Pair(mock_pub_key_hash(0), 1000)] })
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(0)),
            value: from_lovelace(2000),
            datum: InlineDatum(crowdfund_datum_spend),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          address: from_script(mock_policy_id(0)),
          value: from_lovelace(1000),
          datum: InlineDatum(crowdfund_datum),
          reference_script: None,
        },
        Output {
          address: mock_pub_key_address(0, None),
          value: from_lovelace(1000),
          datum: InlineDatum(None),
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1754027120), Some(1754027120)),
    }

  crowdfund.spend(
    mock_pub_key_hash(0),
    4000,
    1753162920,
    crowdfund_datum_spend,
    RECLAIM,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_spend_no_datum() {
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: mock_pub_key_address(0, None),
            value: from_lovelace(1000),
            datum: InlineDatum(None),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
    }

  crowdfund.spend(
    mock_pub_key_hash(0),
    1000,
    1753162920,
    None,
    WITHDRAW,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_spend_goal_reached() {
  let crowdfund_datum = Some(CrowdfundDatum { wallets: [] })
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: mock_pub_key_address(0, None),
            value: from_lovelace(2000),
            datum: InlineDatum(crowdfund_datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      extra_signatories: [mock_pub_key_hash(0)],
      validity_range: mock_interval(Some(1754027120), Some(1754027120)),
    }

  crowdfund.spend(
    mock_pub_key_hash(0),
    1000,
    1753939940,
    crowdfund_datum,
    WITHDRAW,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_not_spend_goal_reached_to_early() fail {
  let crowdfund_datum = Some(CrowdfundDatum { wallets: [] })
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: mock_pub_key_address(0, None),
            value: from_lovelace(2000),
            datum: InlineDatum(crowdfund_datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      extra_signatories: [mock_pub_key_hash(0)],
      validity_range: mock_interval(Some(1753939920), Some(1753939930)),
    }

  crowdfund.spend(
    mock_pub_key_hash(0),
    1000,
    1753939940,
    crowdfund_datum,
    WITHDRAW,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_not_spend_goal_not_reached() fail {
  let crowdfund_datum = Some(CrowdfundDatum { wallets: [] })
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: mock_pub_key_address(0, None),
            value: from_lovelace(999),
            datum: InlineDatum(crowdfund_datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      extra_signatories: [mock_pub_key_hash(0)],
      validity_range: // 1st of August 2025 - for 5 minutes
      mock_interval(Some(1754027120), Some(1754027120)),
    }

  crowdfund.spend(
    mock_pub_key_hash(0),
    1000,
    1753939940,
    crowdfund_datum,
    WITHDRAW,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}
