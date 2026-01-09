use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use cocktail/vodka_outputs.{outputs_with}
use editable_nft_state.{StateDatum}

validator editable_nft_mint(utxo_ref: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, outputs, mint, .. } = tx
    expect [Pair(asset_name, quantity)] =
      mint
        |> assets.tokens(policy_id)
        |> dict.to_pairs()

    let is_output_consumed =
      list.any(inputs, fn(input) { input.output_reference == utxo_ref })

    expect [state_script_out] = outputs |> outputs_with(policy_id, asset_name)

    expect InlineDatum(state_datum) = state_script_out.datum
    expect StateDatum { .. } = state_datum

    is_output_consumed? && (quantity == 1)?
  }

  else(_) {
    fail
  }
}
