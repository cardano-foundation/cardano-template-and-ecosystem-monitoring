use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}

pub type ProductDatum {
  tag: ByteArray,
}

validator product(
  owner: VerificationKeyHash,
  _factory_id: PolicyId,
  _product_id: ByteArray,
) {
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
