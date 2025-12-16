use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}

pub type MintRedeemer {
  password: ByteArray,
}

validator placeholder {
  mint(redeemer: MintRedeemer, _policy_id: PolicyId, _self: Transaction) {
    redeemer.password == "super_secret_password"
  }

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
