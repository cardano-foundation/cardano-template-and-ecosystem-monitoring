use cardano/address.{from_script}
use cardano/assets.{from_lovelace}
use cardano/transaction.{InlineDatum, Input, Output, Transaction, placeholder}
use crowdfund.{CrowdfundDatum, RECLAIM, WITHDRAW}
use mocktail/virgin_address.{mock_pub_key_address}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}
use mocktail/virgin_validity_range.{mock_interval}

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

  crowdfund.crowdfund.spend(
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

  crowdfund.crowdfund.spend(
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

  crowdfund.crowdfund.spend(
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

  crowdfund.crowdfund.spend(
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

  crowdfund.crowdfund.spend(
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

  crowdfund.crowdfund.spend(
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

  crowdfund.crowdfund.spend(
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

  crowdfund.crowdfund.spend(
    mock_pub_key_hash(0),
    1000,
    1753939940,
    crowdfund_datum,
    WITHDRAW,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}
