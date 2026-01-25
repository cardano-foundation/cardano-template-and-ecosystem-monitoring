use cardano/transaction.{InlineDatum, Transaction}
use cocktail/vodka_extra_signatories.{all_key_signed}
use cocktail/vodka_mints.{only_minted_token,token_minted}
use cocktail/vodka_outputs.{outputs_with}
use lottery.{LotteryDatum}
use cardano/assets.{PolicyId}
pub type MintRedeemer {
  Mint
  Burn
}

validator lottery_creator(_game_index: Int) {
  mint(redeemer: MintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { outputs, mint, extra_signatories, .. } = tx

    when redeemer is {
      Mint -> {
        let lottery_token_minted =
          only_minted_token(mint, policy_id, "LOTTERY_TOKEN", 1)

        // its assumed that the token is sent to the lottery script address through offchain orchestratoin. No specific check here as the game just becomes invalid otherwise
        expect [game_out] = outputs_with(outputs,policy_id, "LOTTERY_TOKEN")
        expect InlineDatum(lottery_datum) = game_out.datum
        expect LotteryDatum { player1, player2, commit1, commit2, .. } =
          lottery_datum
        let players_signed =
          all_key_signed(extra_signatories, [player1, player2])

        players_signed && lottery_token_minted && commit1 != "" && commit2 != ""
      }

      Burn -> token_minted(mint, policy_id, "LOTTERY_TOKEN", -1)
    }
  }

  else(_) {
    fail
  }
}
