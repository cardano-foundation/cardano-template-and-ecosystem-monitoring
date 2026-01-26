use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/transaction.{OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}

pub type PaymentIntent {
  recipient: Address,
  lovelace_amt: Int,
  data: ByteArray,
}

validator payment_intent(owner: VerificationKeyHash) {
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
