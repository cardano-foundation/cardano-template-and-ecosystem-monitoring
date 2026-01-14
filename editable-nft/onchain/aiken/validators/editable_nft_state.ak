use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_inputs.{inputs_with}
use cocktail/vodka_outputs.{outputs_at, outputs_with}

pub type StateDatum {
  owner: VerificationKeyHash,
  sealed: Bool,
  payload: ByteArray,
}

pub type StateRedeemer {
  Update
  Seal
}

validator editable_nft_state(policy_id: PolicyId, asset_name: ByteArray) {
  spend(
    _datum: Option<Data>,
    redeemer: StateRedeemer,
    _utxo: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, .. } = tx

    expect [state_input] = inputs |> inputs_with(policy_id, asset_name)

    expect [state_output] =
      outputs_at(outputs, state_input.output.address)
        |> outputs_with(policy_id, asset_name)

    expect InlineDatum(in_datum) = state_input.output.datum
    expect StateDatum { owner, sealed, .. } = in_datum

    let owner_signed = key_signed(extra_signatories, owner)

    when redeemer is {
      Update -> !sealed && owner_signed
      Seal -> {
        expect InlineDatum(out_datum) = state_output.datum
        expect StateDatum { sealed, .. } = out_datum
        sealed && owner_signed
      }
    }
  }

  else(_) {
    fail
  }
}
