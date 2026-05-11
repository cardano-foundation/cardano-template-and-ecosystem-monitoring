use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray.{from_string}
use cardano/address.{from_script}
use cardano/assets.{PolicyId, from_asset}
use cardano/transaction.{
  Input, NoDatum, Output, OutputReference, Transaction, find_input, placeholder,
}
use mocktail/virgin_address.{mock_pub_key_address}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}
use cocktail/vodka_extra_signatories.{key_signed}

// Single-asset receiver script. Parameterised on (receiver, policy, assetName)
// so each address corresponds to one specific token. When the target asset
// is present, only the receiver can spend AND no other tokens may be routed
// elsewhere in the same tx (anti-batching). UTxOs that lack the target
// asset are spendable unconditionally — see the None branch below.
validator token_transfer(
  receiver: VerificationKeyHash,
  policy: PolicyId,
  assetName: ByteArray,
) {
  spend(
    _datum_opt: Option<Data>,
    _redeemer: Data,
    utxo: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, .. } = tx
    expect Some(spent_input) = find_input(inputs, utxo)
    let policies = spent_input.output.value |> assets.policies()
    let found_policy =
      list.find(policies, fn(policy_id) { policy_id == policy })
    when found_policy is {
      // Asset present: enforce receiver signature AND that no foreign tokens
      // leave the script in this tx. Outputs returning to this address are
      // allowed (re-locking is fine); only departures matter.
      Some(expected_policy) -> {
        let expected_tokens = assets.tokens(spent_input.output.value, policy)
        let unexpected_assets_sent =
          list.any(
            outputs,
            fn(output) {
              let non_lovelace = assets.without_lovelace(output.value)
              let has_unexpected_policies =
                list.any(
                  assets.policies(non_lovelace),
                  fn(p) { p != expected_policy },
                )
              let policy_tokens = assets.tokens(non_lovelace, expected_policy)
              let has_unexpected_names =
                list.any(
                  dict.keys(policy_tokens),
                  fn(name) { name != assetName },
                )
              output.address != spent_input.output.address && (
                has_unexpected_policies || has_unexpected_names
              )
            },
          )
        and {
          unexpected_assets_sent == False,
          expected_policy == policy,
          dict.has_key(expected_tokens, assetName),
          key_signed(extra_signatories, receiver),
        }
      }
      // Liberal escape hatch: dust or unrelated tokens accidentally sent
      // here can be retrieved by anyone. Without this clause such UTxOs
      // would be permanently locked.
      None -> True
    }
  }

  else(_) {
    fail
  }
}

// ============= TESTS =============

/// Test: testing if the receiver can withdraw the asset with only the expected policy involved
test should_withdraw_only_expected_input() {
  let assetName = from_string(@"TestAsset")
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_asset(mock_policy_id(1), assetName, 10),
            datum: NoDatum,
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      extra_signatories: [mock_pub_key_hash(2)],
    }
  token_transfer.spend(
    mock_pub_key_hash(2),
    mock_policy_id(1),
    assetName,
    None,
    None,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

/// Test: testing if the receiver can withdraw the asset with additional assets involved
test should_not_withdraw_unwanted_spend() fail {
  let assetName = from_string(@"TestAsset")
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_asset(mock_policy_id(1), assetName, 10),
            datum: NoDatum,
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      outputs: [
        Output {
          address: mock_pub_key_address(0, None),
          value: from_asset(mock_policy_id(1), assetName, 10)
            |> assets.add(mock_policy_id(1), from_string(@"UnwantedAsset"), 10),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [mock_pub_key_hash(2)],
    }
  token_transfer.spend(
    mock_pub_key_hash(2),
    mock_policy_id(1),
    assetName,
    None,
    None,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

test should_not_withdraw_without_signature() fail {
  let assetName = from_string(@"TestAsset")
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_asset(mock_policy_id(1), assetName, 10),
            datum: NoDatum,
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      extra_signatories: // No signatures provided
      [],
    }
  token_transfer.spend(
    mock_pub_key_hash(2),
    mock_policy_id(1),
    assetName,
    None,
    None,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}

/// Test: Verify that some can unlock utxos without the expected policy involved
test should_withdraw_other_assets() {
  let assetName = from_string(@"TestAsset")
  let test_transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output: Output {
            address: from_script(mock_policy_id(1)),
            value: from_asset(
              mock_policy_id(2),
              from_string(@"NotExpectedAsset"),
              10,
            ),
            datum: NoDatum,
            reference_script: None,
          },
          output_reference: mock_utxo_ref(1, 0),
        },
      ],
      extra_signatories: [
        // Another key that is not the expected one
        mock_pub_key_hash(1),
      ],
    }
  token_transfer.spend(
    mock_pub_key_hash(1),
    mock_policy_id(1),
    assetName,
    None,
    None,
    mock_utxo_ref(1, 0),
    test_transaction,
  )
}
