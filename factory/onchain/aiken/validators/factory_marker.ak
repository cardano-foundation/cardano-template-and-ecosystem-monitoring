use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_mints.{token_minted}

validator factory_marker(
  owner: VerificationKeyHash,
  utxo_ref: OutputReference,
) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, extra_signatories, .. } = tx
    let one_shot_spent =
      list.any(inputs, fn(input) { input.output_reference == utxo_ref })

    let marker_minted = token_minted(tx.mint, policy_id, "FACTORY_MARKER", 1)

    key_signed(extra_signatories, owner)? && one_shot_spent? && marker_minted?
  }

  else(_) {
    fail
  }
}
