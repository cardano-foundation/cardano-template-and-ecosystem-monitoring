
use aiken/crypto.{VerificationKeyHash}
use cardano/transaction.{Transaction, OutputReference}
use vodka_extra_signatories.{key_signed}

pub type OwnerDatum {
  owner: VerificationKeyHash
}

validator simpleTransfer {

  spend(datum_opt: Option<OwnerDatum>, _redeemer: Data, _utxo: OutputReference, self: Transaction) {
    expect Some(datum) = datum_opt
    key_signed(self.extra_signatories, datum.owner)
  }
}
