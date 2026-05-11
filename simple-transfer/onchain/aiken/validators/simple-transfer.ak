use aiken/crypto.{VerificationKeyHash}
use cardano/transaction.{Transaction, OutputReference}
use cocktail/vodka_extra_signatories.{key_signed}

// Minimal "send funds, only X can spend" script. The receiver pkh is baked
// into the script hash as a parameter, so each receiver has a distinct
// address. No datum, no time-locks — just signature-gated withdrawal.
validator simpleTransfer(receiver: VerificationKeyHash) {

  spend(_datum_opt: Option<Data>, _redeemer: Data, _utxo: OutputReference, self: Transaction) {
    key_signed(self.extra_signatories, receiver)
  }

}
