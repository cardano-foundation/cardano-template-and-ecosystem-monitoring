use cardano/assets.{from_asset}
use cardano/transaction.{InlineDatum, Input, Output}
use intent
use mocktail.{add_input, complete, mocktail_tx, required_signer_hash}
use mocktail/virgin_address.{mock_script_address}
use mocktail/virgin_key_hash.{mock_policy_id, mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}

const owner_pkh = mock_pub_key_hash(0)

const attacker = mock_pub_key_hash(1)

const wallet_policy = mock_policy_id(0)

const intent_script_addr = mock_script_address(1, None)

const intent_marker_assetname = "INTENT_MARKER"

test intent_spend_valid() {
  let oref = mock_utxo_ref(0, 0)

  let input =
    Input {
      output_reference: oref,
      output: Output {
        address: intent_script_addr,
        value: from_asset(wallet_policy, intent_marker_assetname, 1),
        datum: InlineDatum("SomeData"),
        reference_script: None,
      },
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner_pkh)
      |> complete()
      |> add_input(True, input)

  intent.payment_intent.spend(owner_pkh, None, None, oref, tx)
}

test intent_spend_invalid_signer() {
  let oref = mock_utxo_ref(0, 0)

  let input =
    Input {
      output_reference: oref,
      output: Output {
        address: intent_script_addr,
        value: from_asset(wallet_policy, intent_marker_assetname, 1),
        datum: InlineDatum("SomeData"),
        reference_script: None,
      },
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, attacker)
      |> complete()
      |> add_input(True, input)

  !intent.payment_intent.spend(owner_pkh, None, None, oref, tx)
}
