use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Transaction, find_script_outputs}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_mints.{token_minted}
use cocktail/vodka_outputs.{outputs_with}
use intent.{PaymentIntent}

pub type WalletRedeemer {
  Mint
  Burn
}

validator wallet(owner: VerificationKeyHash, intent_script_hash: ScriptHash) {
  mint(redeemer: WalletRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { outputs, mint, .. } = tx
    let creator_signed = key_signed(tx.extra_signatories, owner)

    when redeemer is {
      Mint -> {
        let intent_token_minted =
          token_minted(mint, policy_id, "INTENT_MARKER", 1)

        expect [intent_output] =
          find_script_outputs(outputs, intent_script_hash)
            |> outputs_with(policy_id, "INTENT_MARKER")

        expect InlineDatum(raw_intent_datum) = intent_output.datum
        expect _intent_datum: PaymentIntent = raw_intent_datum

        creator_signed && intent_token_minted
      }

      Burn -> {
        let intent_token_burned =
          token_minted(mint, policy_id, "INTENT_MARKER", -1)

        creator_signed && intent_token_burned
      }
    }
  }

  else(_) {
    fail
  }
}
