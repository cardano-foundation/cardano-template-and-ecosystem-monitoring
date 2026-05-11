use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use cocktail/vodka_address.{address_script_hash}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_inputs.{inputs_with}
use cocktail/vodka_mints.{only_minted_token}
use cocktail/vodka_outputs.{outputs_with}
use types.{ProductDatum}

// Product validator/policy authorised by a factory. Parameterised on the
// factory marker policy so a product mint is only valid in a transaction
// that simultaneously spends the factory UTxO — the factory's own validator
// updates its datum, making the chain of authorisation enforceable.
validator product(
  owner: VerificationKeyHash,
  factory_marker_policy: PolicyId,
  product_id: ByteArray,
) {
  mint(_redeemer: Data, policy_id: PolicyId, tx: Transaction) {
    let Transaction { inputs, outputs, extra_signatories, mint, .. } = tx
    let product_minted = only_minted_token(mint, policy_id, product_id, 1)

    // The factory must be spent in the same tx — exactly one input with the
    // marker — so the factory validator's CreateProduct rule runs and
    // records this product into the factory datum.
    let factory_marker_spent =
      (
        inputs_with(inputs, factory_marker_policy, "FACTORY_MARKER")
          |> list.length
      ) == 1

    // Force the product to land at a script address with an inline datum,
    // so downstream contracts can locate and reason about it.
    expect [product_out] = outputs_with(outputs, policy_id, product_id)
    expect Some(_product_script_hash) = address_script_hash(product_out.address)
    expect InlineDatum(product_datum) = product_out.datum
    expect ProductDatum { tag: _tag } = product_datum

    key_signed(extra_signatories, owner) && factory_marker_spent && product_minted
  }

  // Owner-only spend. No datum machinery here — once minted, the product
  // UTxO is admin-controlled by the same owner that ran the factory.
  spend(
    _datum_opt: Option<Data>,
    _redeemer: Data,
    _utxo: OutputReference,
    tx: Transaction,
  ) {
    key_signed(tx.extra_signatories, owner)
  }

  else(_) {
    fail
  }
}
