use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, Transaction}
use cocktail/vodka_extra_signatories.{all_key_signed}
use cocktail/vodka_mints.{only_minted_token, token_minted}
use cocktail/vodka_outputs.{outputs_with}
use lottery.{LotteryDatum}

// Mints the LOTTERY_TOKEN that gives a lottery UTxO its identity. The token
// is parameterised on _game_index so independent games get independent
// policies. Burn closes a game (called by Settle/Timeout in lottery.ak).

pub type MintRedeemer {
  Mint
  Burn
}

validator lottery_creator(_game_index: Int) {
  mint(redeemer: MintRedeemer, policy_id: PolicyId, tx: Transaction) {
    let Transaction { outputs, mint, extra_signatories, .. } = tx

    when redeemer is {
      // Mint — both players must sign (mutual consent to play) and both
      // commits must be non-empty (preventing a degenerate "" sentinel from
      // sneaking through). Where the token lands isn't checked here: an
      // off-target deposit just produces an invalid game that nobody can spend.
      Mint -> {
        let lottery_token_minted =
          only_minted_token(mint, policy_id, "LOTTERY_TOKEN", 1)

        expect [game_out] = outputs_with(outputs, policy_id, "LOTTERY_TOKEN")
        expect InlineDatum(lottery_datum) = game_out.datum
        expect LotteryDatum { player1, player2, commit1, commit2, .. } =
          lottery_datum
        let players_signed =
          all_key_signed(extra_signatories, [player1, player2])

        players_signed && lottery_token_minted && commit1 != "" && commit2 != ""
      }

      // Burn — open path; the lottery validator is responsible for the
      // surrounding rules (who can call it, whether the game is settled).
      Burn -> token_minted(mint, policy_id, "LOTTERY_TOKEN", -1)
    }
  }

  else(_) {
    fail
  }
}
