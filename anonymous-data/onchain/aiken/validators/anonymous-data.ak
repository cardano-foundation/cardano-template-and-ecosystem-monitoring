use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray.{concat}
use cardano/address.{Credential}
use cardano/assets.{PolicyId}
use cardano/certificate.{Certificate}
use cardano/governance.{ProposalProcedure, Voter}
use cardano/transaction.{OutputReference, Transaction}
use cocktail/vodka_mints.{token_minted}

validator anonymous(id: ByteArray, nonce: ByteArray) {
  mint(redeemer: ByteArray, policy_id: PolicyId, tx: Transaction) {
    let data_token = token_minted(tx.mint, policy_id, id, 1)

    let matches_id =
      list.any(
        tx.extra_signatories,
        fn(pkh) { blake2b_256(concat(pkh, nonce)) == id },
      )

    data_token && matches_id
  }

  spend(
    _datum: Option<Data>,
    _redeemer: Data,
    _utxo: OutputReference,
    _self: Transaction,
  ) {
    todo @"spend logic goes here"
  }

  else(_) {
    fail
  }
}
