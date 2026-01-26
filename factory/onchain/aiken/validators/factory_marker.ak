use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/address.{from_script}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_mints.{token_minted}
use cocktail/vodka_outputs.{outputs_with}

validator factory_marker(
  owner: VerificationKeyHash,
  utxo_ref: OutputReference,
  factory_script_hash: ScriptHash,
) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, extra_signatories, .. } = tx
    let one_shot_spent =
      list.any(inputs, fn(input) { input.output_reference == utxo_ref })

    let marker_minted = token_minted(tx.mint, policy_id, "FACTORY_MARKER", 1)

    let marker_locked_at_factory =
      tx.outputs
        |> outputs_with(policy_id, "FACTORY_MARKER")
        |> list.any(fn(o) { o.address == from_script(factory_script_hash) })

    key_signed(extra_signatories, owner) && one_shot_spent && marker_minted && marker_locked_at_factory
  }

  else(_) {
    fail
  }
}
