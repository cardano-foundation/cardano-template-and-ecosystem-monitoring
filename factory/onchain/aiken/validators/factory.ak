use aiken/crypto.{VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{Transaction}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_mints.{token_minted}

pub type FactoryRedeemer {
  CreateProduct { product_id: ByteArray }
}

validator factory(owner: VerificationKeyHash) {
  mint(redeemer: FactoryRedeemer, policy_id: PolicyId, tx: Transaction) {
    let owner_signed = key_signed(tx.extra_signatories, owner)

     let CreateProduct { product_id } = redeemer
    let product_nft_minted = token_minted(tx.mint, policy_id, product_id, 1)

    owner_signed && product_nft_minted
  }

  else(_) {
    fail
  }
}
