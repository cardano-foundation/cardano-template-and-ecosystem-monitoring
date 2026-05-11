use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_mints.{token_minted}

// One-shot policy that mints a single FACTORY_MARKER NFT. The marker is the
// factory's identity token and is held by the factory script for life — its
// uniqueness is enforced by parameterising on a UTxO reference that must be
// consumed in the minting tx, so the policy hash is unforgeable per-factory.
validator factory_marker(
  owner: VerificationKeyHash,
  utxo_ref: OutputReference,
) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, extra_signatories, .. } = tx
    // Consuming utxo_ref makes this policy run at most once: after the
    // owner spends it, no future tx can satisfy this clause.
    let one_shot_spent =
      list.any(inputs, fn(input) { input.output_reference == utxo_ref })

    let marker_minted = token_minted(tx.mint, policy_id, "FACTORY_MARKER", 1)

    key_signed(extra_signatories, owner)? && one_shot_spent? && marker_minted?
  }

  else(_) {
    fail
  }
}
