use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{from_script}
use cardano/assets.{from_lovelace}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input,
  placeholder,
}
use vodka_extra_signatories.{key_signed}
use vodka_validity_range.{valid_before}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}
use mocktail/virgin_validity_range.{mock_interval}

pub type Delegate {
  key: VerificationKeyHash,
  expires: Int,
}

pub type IdentityDatum {
  owner: VerificationKeyHash,
  delegates: List<Delegate>,
}

pub type Action {
  TransferOwner { new_owner: VerificationKeyHash }
  AddDelegate { delegate: VerificationKeyHash, expires: Int }
  RemoveDelegate { delegate: VerificationKeyHash }
}

fn has_delegate(delegates: List<Delegate>, key: VerificationKeyHash) -> Bool {
  list.any(delegates, fn(d) { d.key == key })
}

validator identity {
  spend(
    datum_opt: Option<IdentityDatum>,
    redeemer: Action,
    spent_ref: OutputReference,
    transaction: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      transaction

    // expect Some(datum) = datum_opt
    expect Some(spent_input) = find_input(inputs, spent_ref)
    let Output { datum: input_datum, address, value: input_value, .. } =
      spent_input.output

    expect InlineDatum(input_data) = input_datum
    expect IdentityDatum { owner, delegates } = input_data

    let continuing_outputs =
      list.filter(outputs, fn(output) { output.address == address })

    expect list.length(continuing_outputs) == 1
    expect Some(continuing_output) = list.head(continuing_outputs)
    let Output { datum: output_datum, value: output_value, .. } =
      continuing_output

    expect InlineDatum(output_data) = output_datum
    expect new_state: IdentityDatum = output_data

    let owner_signed = key_signed(extra_signatories, owner)

    when redeemer is {
      TransferOwner { new_owner } -> {
        and {
          owner_signed?,
          (new_state.owner == new_owner)?,
          (new_state.delegates == delegates)?,
          (input_value == output_value)?,
        }
      }
      AddDelegate { delegate, expires } -> {
        and {
          owner_signed?,
          (new_state.owner == owner)?,
          not (has_delegate(delegates, delegate))?,
          has_delegate(new_state.delegates, delegate)?,
          (list.length(new_state.delegates) == list.length(delegates) + 1)?,
          (delegate != owner)?,
          valid_before(validity_range, expires)?,
          (input_value == output_value)?,
        }
      }
      RemoveDelegate { delegate } -> {
        and {
          owner_signed?,
          (new_state.owner == owner)?,
          has_delegate(delegates, delegate)?,
          not (has_delegate(new_state.delegates, delegate))?,
          (list.length(new_state.delegates) + 1 == list.length(delegates))?,
          (input_value == output_value)?,
        }
      }
    }
  }
}

// ============= TESTS =============

test transfer_owner_updates_state() {
  let initial_state =
    IdentityDatum { owner: mock_pub_key_hash(1), delegates: [] }
  let updated_state =
    IdentityDatum { owner: mock_pub_key_hash(2), delegates: [] }

  let script_address = from_script(mock_policy_id(1))

  let transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output_reference: mock_utxo_ref(1, 0),
          output: Output {
            address: script_address,
            value: from_lovelace(3000000),
            datum: InlineDatum(initial_state),
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: script_address,
          value: from_lovelace(3000000),
          datum: InlineDatum(updated_state),
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(None, None),
    }

  identity.spend(
    Some(initial_state),
    TransferOwner { new_owner: mock_pub_key_hash(2) },
    mock_utxo_ref(1, 0),
    transaction,
  )
}

test add_delegate_extends_list() {
  let initial_state =
    IdentityDatum { owner: mock_pub_key_hash(1), delegates: [] }
  let expires = 2000
  let updated_state =
    IdentityDatum {
      owner: mock_pub_key_hash(1),
      delegates: [Delegate { key: mock_pub_key_hash(2), expires }],
    }

  let script_address = from_script(mock_policy_id(1))

  let transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output_reference: mock_utxo_ref(1, 0),
          output: Output {
            address: script_address,
            value: from_lovelace(3000000),
            datum: InlineDatum(initial_state),
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: script_address,
          value: from_lovelace(3000000),
          datum: InlineDatum(updated_state),
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(1)],
      validity_range: mock_interval(Some(1000), Some(1500)),
    }

  identity.spend(
    Some(initial_state),
    AddDelegate { delegate: mock_pub_key_hash(2), expires },
    mock_utxo_ref(1, 0),
    transaction,
  )
}
