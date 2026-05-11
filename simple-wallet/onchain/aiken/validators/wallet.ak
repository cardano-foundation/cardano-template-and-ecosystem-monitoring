use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Transaction, find_script_outputs}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_mints.{token_minted}
use cocktail/vodka_outputs.{outputs_with}
use intent.{PaymentIntent}

// Wallet minting policy. Mints/burns the INTENT_MARKER NFT that ties a
// PaymentIntent UTxO at the intent script to this owner. Burn is unrestricted
// in shape (any single-token burn) so funds.ak can call it as part of
// ExecuteTx without naming the intent here.

pub type WalletRedeemer {
  Mint
  Burn
}

validator wallet(owner: VerificationKeyHash, intent_script_hash: ScriptHash) {
  mint(redeemer: WalletRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { outputs, mint, .. } = tx
    let creator_signed = key_signed(tx.extra_signatories, owner)

    when redeemer is {
      // Mint — owner attaches a new intent. Marker must land at the intent
      // script with a well-formed PaymentIntent datum, otherwise the intent
      // would dangle (token exists but no readable payload).
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

      // Burn — owner-signed marker destruction. Called by ExecuteTx (to retire
      // a fulfilled intent) and by direct cancellation flows.
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
