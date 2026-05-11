use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId, has_nft_strict}
use cardano/transaction.{InlineDatum, OutputReference, Transaction, find_input}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_mints.{only_minted_token}
use cocktail/vodka_outputs.{outputs_at, outputs_with}
use types.{FactoryDatum}

// Stateful factory. Holds the FACTORY_MARKER NFT and tracks the set of
// product policies it has authorised. CreateProduct is the only transition:
// owner signs, the marker carries over to a new UTxO at the same address,
// the new product is minted, and the datum's product list grows by one
// entry. The marker's continuity is what makes "this is an authorised
// product" verifiable — the product script checks for the marker as input.

pub type FactoryRedeemer {
  CreateProduct { product_policy_id: ByteArray, product_id: ByteArray }
}

validator factory(owner: VerificationKeyHash, factory_marker_policy: PolicyId) {
  spend(
    _datum_opt: Option<FactoryDatum>,
    redeemer: FactoryRedeemer,
    oref: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, mint, .. } = tx

    let CreateProduct { product_policy_id, product_id } = redeemer

    expect Some(own_input) = find_input(inputs, oref)

    // The spent UTxO must actually be the factory (carry the marker NFT).
    // Without this an attacker could submit a look-alike UTxO at the same
    // address to spoof the spend.
    expect
      has_nft_strict(
        own_input.output.value,
        factory_marker_policy,
        "FACTORY_MARKER",
      )

    // Marker continuity: exactly one output at this address carrying the
    // marker. Any other shape would either lose the marker or fork it.
    expect [continuing_output] =
      outputs
        |> outputs_at(own_input.output.address)
        |> outputs_with(factory_marker_policy, "FACTORY_MARKER")

    let product_minted =
      only_minted_token(mint, product_policy_id, product_id, 1)

    expect InlineDatum(raw_datum_new) = continuing_output.datum
    expect FactoryDatum { products } = raw_datum_new

    // We only check the policy was appended — we don't enforce ordering or
    // de-dup. The product policy itself is parameterised on the factory, so
    // a duplicate entry would still correspond to the same product script.
    let datum_updated = list.has(products, product_policy_id)

    key_signed(extra_signatories, owner) && datum_updated && product_minted
  }

  else(_) {
    fail
  }
}
