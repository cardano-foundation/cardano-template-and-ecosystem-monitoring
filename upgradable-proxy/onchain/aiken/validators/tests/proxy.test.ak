use aiken/crypto.{sha3_256}
use aiken/primitive/bytearray.{concat}
use aiken/primitive/int
use aiken/primitive/string
use cardano/address.{Script, from_script}
use cardano/assets.{from_asset, from_lovelace}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, Transaction, placeholder,
}
use mocktail/virgin_address.{mock_pub_key_address}
use mocktail/virgin_key_hash.{
  mock_policy_id, mock_pub_key_hash, mock_script_hash,
}
use mocktail/virgin_output_reference.{mock_utxo_ref}
use proxy.{INIT, MINT, ProxyDatum, SPEND}
use script_logic_v_1.{MyRedeemer}

test should_init_a_proxy_contract() {
  let policy_id = mock_policy_id(1)
  let redeemer = INIT
  let utxo_ref = mock_utxo_ref(0, 0)

  let state_token_name =
    sha3_256(
      concat(
        utxo_ref.transaction_id,
        string.to_bytearray(int.to_string(utxo_ref.output_index)),
      ),
    )

  let datum =
    ProxyDatum {
      script_pointer: mock_script_hash(1),
      script_owner: mock_pub_key_hash(0),
    }

  let transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output_reference: utxo_ref,
          output: Output {
            address: mock_pub_key_address(0, None),
            value: from_lovelace(1293000),
            datum: NoDatum,
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: from_script(policy_id),
          value: from_asset(policy_id, state_token_name, 1),
          datum: InlineDatum(datum),
          reference_script: None,
        },
      ],
      mint: from_asset(policy_id, state_token_name, 1),
      extra_signatories: [mock_pub_key_hash(0)],
    }

  proxy.proxy.mint(utxo_ref, redeemer, policy_id, transaction)
}

test should_mint_via_proxy_contract() {
  let policy_id = mock_policy_id(1)
  let redeemer = MINT
  let utxo_ref = mock_utxo_ref(0, 0)
  let state_token_name =
    sha3_256(
      concat(
        utxo_ref.transaction_id,
        string.to_bytearray(int.to_string(utxo_ref.output_index)),
      ),
    )

  let datum =
    ProxyDatum {
      script_pointer: mock_script_hash(1),
      script_owner: mock_pub_key_hash(0),
    }

  let transaction =
    Transaction {
      ..placeholder,
      mint: from_asset(policy_id, "Test", 1),
      reference_inputs: [
        Input {
          output_reference: mock_utxo_ref(0, 1),
          output: Output {
            address: from_script(policy_id),
            value: from_asset(policy_id, state_token_name, 1),
            datum: InlineDatum(datum),
            reference_script: None,
          },
        },
      ],
      withdrawals: [Pair(Script(mock_script_hash(1)), 0)],
    }

  let script_logic_redeemer =
    MyRedeemer { token_name: "Test", password: "Hello, World!" }

  and {
    proxy.proxy.mint(utxo_ref, redeemer, policy_id, transaction),
    script_logic_v_1.script_logic_version_1_0.withdraw(
      policy_id,
      script_logic_redeemer,
      Script(mock_script_hash(1)),
      transaction,
    ),
  }
}

test should_spend_via_proxy_contract() {
  let policy_id = mock_policy_id(1)
  let redeemer = SPEND
  let utxo_ref = mock_utxo_ref(0, 0)

  let spent_utxo = mock_utxo_ref(1, 0)

  let state_token_name =
    sha3_256(
      concat(
        utxo_ref.transaction_id,
        string.to_bytearray(int.to_string(utxo_ref.output_index)),
      ),
    )

  let datum =
    ProxyDatum {
      script_pointer: mock_script_hash(1),
      script_owner: mock_pub_key_hash(0),
    }

  let transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output_reference: spent_utxo,
          output: Output {
            address: from_script(policy_id),
            value: from_lovelace(1293000),
            datum: NoDatum,
            reference_script: None,
          },
        },
      ],
      reference_inputs: [
        Input {
          output_reference: mock_utxo_ref(0, 1),
          output: Output {
            address: from_script(policy_id),
            value: from_asset(policy_id, state_token_name, 1),
            datum: InlineDatum(datum),
            reference_script: None,
          },
        },
      ],
      withdrawals: [Pair(Script(mock_script_hash(1)), 0)],
      extra_signatories: [mock_pub_key_hash(4)],
    }

  let script_logic_redeemer =
    MyRedeemer { token_name: "Test", password: "Hello, World!" }

  and {
    proxy.proxy.spend(utxo_ref, None, redeemer, spent_utxo, transaction),
    script_logic_v_1.script_logic_version_1_0.withdraw(
      policy_id,
      script_logic_redeemer,
      Script(mock_script_hash(1)),
      transaction,
    ),
  }
}
