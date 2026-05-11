use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/transaction.{OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}

// Holds a single PaymentIntent (recipient, amount, opaque data). The intent
// is read by funds.ak as a reference input during ExecuteTx and burned when
// the intent is consumed. Owner-only spend lets the wallet owner cancel an
// intent before it's executed.

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
