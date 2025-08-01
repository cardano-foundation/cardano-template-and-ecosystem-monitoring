
use aiken/crypto.{VerificationKeyHash}
use cardano/transaction.{Transaction, OutputReference}
use vodka_extra_signatories.{key_signed}

// Parameterized validator for simple transfer
// This validator checks if the transaction is signed by the receiver's verification key hash
// Others can lock funds in the contract, but only the receiver can spend them.
// The receiver is specified as a parameter to the validator.
validator simpleTransfer(receiver: VerificationKeyHash) {

  spend(_datum_opt: Option<Data>, _redeemer: Data, _utxo: OutputReference, self: Transaction) {
    key_signed(self.extra_signatories, receiver)
  }
  
}
