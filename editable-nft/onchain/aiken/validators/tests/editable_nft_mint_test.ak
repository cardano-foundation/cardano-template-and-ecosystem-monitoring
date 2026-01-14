use cardano/assets.{from_asset}
use cardano/transaction.{InlineDatum, Input, Output}
use editable_nft_mint
use editable_nft_state.{StateDatum}
use mocktail.{
  add_input, complete, mint, mocktail_tx, tx_out, tx_out_inline_datum,
}
use mocktail/virgin_address.{mock_script_address}
use mocktail/virgin_key_hash.{mock_pub_key_hash, mock_script_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}

const owner = mock_pub_key_hash(0)

const policy_id = mock_script_hash(0)

const state_script_addr = mock_script_address(1, None)

const asset_name = "EDITABLE_NFT"

fn mk_consumed_input(oref) {
  Input {
    output_reference: oref,
    output: Output {
      address: mock_script_address(99, None),
      value: from_asset(policy_id, asset_name, 1),
      datum: InlineDatum(""),
      reference_script: None,
    },
  }
}

// --------------------------------------------------
// Mint — VALID
// --------------------------------------------------

test editable_nft_mint_valid() {
  let seed_oref = mock_utxo_ref(0, 0)

  let consumed_input = mk_consumed_input(seed_oref)

  let state_datum = StateDatum { owner, sealed: False, payload: "hello" }

  let tx =
    mocktail_tx()
      |> mint(True, 1, policy_id, asset_name)
      |> tx_out(True, state_script_addr, from_asset(policy_id, asset_name, 1))
      |> tx_out_inline_datum(True, state_datum)
      |> complete()
      |> add_input(True, consumed_input)

  editable_nft_mint.editable_nft_mint.mint(seed_oref, "", policy_id, tx)
}

// --------------------------------------------------
// Mint — FAIL: quantity ≠ 1
// --------------------------------------------------

test editable_nft_mint_wrong_quantity() {
  let seed_oref = mock_utxo_ref(0, 0)

  let consumed_input = mk_consumed_input(seed_oref)

  let state_datum = StateDatum { owner, sealed: False, payload: "hello" }

  let tx =
    mocktail_tx()
      |> mint(True, 2, policy_id, asset_name)
      |> tx_out(True, state_script_addr, from_asset(policy_id, asset_name, 1))
      |> tx_out_inline_datum(True, state_datum)
      |> complete()
      |> add_input(True, consumed_input)

  !editable_nft_mint.editable_nft_mint.mint(seed_oref, "", policy_id, tx)
}

// --------------------------------------------------
// Mint — FAIL: seed UTxO not consumed
// --------------------------------------------------

test editable_nft_mint_seed_not_consumed() {
  let seed_oref = mock_utxo_ref(0, 0)

  let state_datum = StateDatum { owner, sealed: False, payload: "hello" }

  let tx =
    mocktail_tx()
      |> mint(True, 1, policy_id, asset_name)
      |> tx_out(True, state_script_addr, from_asset(policy_id, asset_name, 1))
      |> tx_out_inline_datum(True, state_datum)
      |> complete()

  !editable_nft_mint.editable_nft_mint.mint(seed_oref, "", policy_id, tx)
}
