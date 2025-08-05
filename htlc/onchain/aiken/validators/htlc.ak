use cardano/transaction.{Transaction, OutputReference}
use cocktail/vodka_validity_range.{valid_after, valid_before}
use aiken/crypto.{VerificationKeyHash}
use cocktail/vodka_extra_signatories.{key_signed}

pub type Htlc {
  GUESS {answer: ByteArray}
  WITHDRAW
}

// HTLC is a hash timed locked contract
// This validator is used to handle HTLC operations on the Cardano blockchain.
// The owner locks funds in the contract by providing a hash and a timeout.
// The receiver can claim the funds if provided a bytestring hash that matches the one used to lock the funds and before the timeout.
// If the timeout is reached, the owner can withdraw the funds.
validator htlc(secret: ByteArray, expiration: Int, owner: VerificationKeyHash) {

  spend(_datum: Option<Data>, redeemer: Htlc, _utxo: OutputReference, tx: Transaction) {
    let Transaction {extra_signatories, validity_range, ..} = tx
    when redeemer is {
      GUESS {answer} -> {
        and{
          valid_before(validity_range, expiration), // The guess must be made before the expiration time
          (answer == secret)
        }
      }
      WITHDRAW -> {
          and {
            valid_after(validity_range, expiration), // The owner can withdraw after the expiration time
            key_signed(extra_signatories, owner)
          }
      }
    }
  }
}
