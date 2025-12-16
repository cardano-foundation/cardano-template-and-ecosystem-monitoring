use cardano/address.{from_script}
use cardano/assets.{from_lovelace}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, Transaction, placeholder,
}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}
use mocktail/virgin_validity_range.{mock_interval}
use vault.{Action, WithdrawDatum}

test should_withdraw_multiple_utxos() {
  let datum = WithdrawDatum { lock_time: 100 }
  let outputs =
    [
      Output {
        address: from_script(mock_policy_id(1)),
        value: from_lovelace(1000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
      Output {
        address: from_script(mock_policy_id(1)),
        value: from_lovelace(1000),
        datum: NoDatum,
        reference_script: None,
      },
    ]
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(2000),
            datum: NoDatum,
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: outputs,
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1000), Some(1100)),
    }
  vault.vault.spend(
    mock_pub_key_hash(1),
    100,
    Some(datum),
    Action.WITHDRAW,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_not_withdraw_wrong_amount() fail {
  let datum = Some(WithdrawDatum { lock_time: 100 })
  let outputs =
    [
      Output {
        address: from_script(mock_policy_id(1)),
        value: from_lovelace(1001),
        datum: InlineDatum(datum),
        reference_script: None,
      },
      Output {
        address: from_script(mock_policy_id(1)),
        value: from_lovelace(1000),
        datum: NoDatum,
        reference_script: None,
      },
    ]
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(2000),
            datum: NoDatum,
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: outputs,
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1000), Some(1100)),
    }
  vault.vault.spend(
    mock_pub_key_hash(1),
    100,
    datum,
    Action.WITHDRAW,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_not_withdraw_lock_after_tx() fail {
  let datum = Some(WithdrawDatum { lock_time: 1001 })
  let outputs =
    [
      Output {
        address: from_script(mock_policy_id(1)),
        value: from_lovelace(1000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
      Output {
        address: from_script(mock_policy_id(1)),
        value: from_lovelace(1000),
        datum: NoDatum,
        reference_script: None,
      },
    ]
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(2000),
            datum: NoDatum,
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: outputs,
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1000), Some(1100)),
    }
  vault.vault.spend(
    mock_pub_key_hash(1),
    100,
    datum,
    Action.WITHDRAW,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_not_withdraw_spend_with_datum() fail {
  let datum = Some(WithdrawDatum { lock_time: 1001 })
  let outputs =
    [
      Output {
        address: from_script(mock_policy_id(1)),
        value: from_lovelace(1000),
        datum: InlineDatum(datum),
        reference_script: None,
      },
      Output {
        address: from_script(mock_policy_id(1)),
        value: from_lovelace(1000),
        datum: NoDatum,
        reference_script: None,
      },
    ]
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(2000),
            datum: InlineDatum(datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: outputs,
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1000), Some(1100)),
    }
  vault.vault.spend(
    mock_pub_key_hash(1),
    100,
    datum,
    Action.WITHDRAW,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_finalize() {
  let datum = Some(WithdrawDatum { lock_time: 100 })
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(1000),
            datum: InlineDatum(datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          address: from_script(mock_policy_id(2)),
          value: from_lovelace(1000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1000), Some(1100)),
    }
  vault.vault.spend(
    mock_pub_key_hash(1),
    100,
    datum,
    Action.FINALIZE,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_not_finalize_before_lock_time() fail {
  let datum = Some(WithdrawDatum { lock_time: 901 })
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_lovelace(1000),
            datum: InlineDatum(datum),
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          address: from_script(mock_policy_id(2)),
          value: from_lovelace(1000),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1000), Some(1100)),
    }
  vault.vault.spend(
    mock_pub_key_hash(1),
    100,
    datum,
    Action.FINALIZE,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}
