use cardano/assets.{from_asset}
use cardano/transaction.{InlineDatum, Input, Output}
use editable_nft_state.{Seal, StateDatum, Update}
use mocktail.{
  add_input, complete, mocktail_tx, required_signer_hash, tx_out,
  tx_out_inline_datum,
}
use mocktail/virgin_address.{mock_script_address}
use mocktail/virgin_key_hash.{mock_pub_key_hash, mock_script_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}

const owner = mock_pub_key_hash(0)

const attacker = mock_pub_key_hash(1)

const policy_id = mock_script_hash(0)

const asset_name = "EDITABLE_NFT"

const state_addr = mock_script_address(1, None)

fn mk_state_input(datum) {
  Input {
    output_reference: mock_utxo_ref(0, 0),
    output: Output {
      address: state_addr,
      value: from_asset(policy_id, asset_name, 1),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

// --------------------------------------------------
// Update — VALID
// --------------------------------------------------

test editable_nft_update_valid() {
  let input_datum = StateDatum { owner, sealed: False, payload: "v1" }

  let input = mk_state_input(input_datum)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner)
      |> tx_out(True, state_addr, from_asset(policy_id, asset_name, 1))
      |> tx_out_inline_datum(True, input_datum)
      |> complete()
      |> add_input(True, input)

  editable_nft_state.editable_nft_state.spend(
    policy_id,
    asset_name,
    None,
    Update,
    mock_utxo_ref(0, 0),
    tx,
  )
}

// --------------------------------------------------
// Update — FAIL: sealed
// --------------------------------------------------

test editable_nft_update_sealed() {
  let input_datum = StateDatum { owner, sealed: True, payload: "v1" }

  let input = mk_state_input(input_datum)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner)
      |> tx_out(True, state_addr, from_asset(policy_id, asset_name, 1))
      |> tx_out_inline_datum(True, input_datum)
      |> complete()
      |> add_input(True, input)

  !editable_nft_state.editable_nft_state.spend(
    policy_id,
    asset_name,
    None,
    Update,
    mock_utxo_ref(0, 0),
    tx,
  )
}

// --------------------------------------------------
// Seal — VALID
// --------------------------------------------------

test editable_nft_seal_valid() {
  let input_datum = StateDatum { owner, sealed: False, payload: "v1" }

  let output_datum = StateDatum { owner, sealed: True, payload: "v1" }

  let input = mk_state_input(input_datum)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, owner)
      |> tx_out(True, state_addr, from_asset(policy_id, asset_name, 1))
      |> tx_out_inline_datum(True, output_datum)
      |> complete()
      |> add_input(True, input)

  editable_nft_state.editable_nft_state.spend(
    policy_id,
    asset_name,
    None,
    Seal,
    mock_utxo_ref(0, 0),
    tx,
  )
}

// --------------------------------------------------
// Seal — FAIL: wrong signer
// --------------------------------------------------

test editable_nft_seal_wrong_signer() {
  let input_datum = StateDatum { owner, sealed: False, payload: "v1" }

  let output_datum = StateDatum { owner, sealed: True, payload: "v1" }

  let input = mk_state_input(input_datum)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, attacker)
      |> tx_out(True, state_addr, from_asset(policy_id, asset_name, 1))
      |> tx_out_inline_datum(True, output_datum)
      |> complete()
      |> add_input(True, input)

  !editable_nft_state.editable_nft_state.spend(
    policy_id,
    asset_name,
    None,
    Seal,
    mock_utxo_ref(0, 0),
    tx,
  )
}
