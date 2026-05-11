use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}

// Toy script used as the atomic-transaction example target.
// Mint requires a literal password in the redeemer; spend is unrestricted.
// The point of the example is to demonstrate that a single transaction can
// combine a guarded mint with arbitrary spends across multiple scripts.

pub type MintRedeemer {
  password: ByteArray,
}

validator placeholder {
  // Pre-shared password gate. Trivial on purpose — real policies would check
  // signatures, oracle datums, etc. Keeps the demo focused on tx composition.
  mint(redeemer: MintRedeemer, _policy_id: PolicyId, _self: Transaction) {
    redeemer.password == "super_secret_password"
  }

  // Open spend — anyone can unlock. Off-chain orchestration decides who pays.
  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    True
  }

  else(_) {
    fail
  }
}
