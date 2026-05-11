use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_256}
use aiken/primitive/int
use cardano/assets.{PolicyId}
use cardano/transaction.{InlineDatum, OutputReference, Transaction, find_input}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_inputs.{inputs_with_policy}
use cocktail/vodka_mints.{only_minted_token}
use cocktail/vodka_validity_range.{valid_after}

// Commit-reveal 2-player lottery. Both players commit blake2b_256 hashes of
// numbers up-front (see lottery_creator). Lifecycle: Reveal1 -> Reveal2 ->
// Settle (winner = (n1+n2) mod 2). Each reveal step also enforces ordering
// (P1 first, then P2) to prevent P2 grinding their reveal after seeing P1's.
// Timeout1/Timeout2 give the non-stalling player the pot if their opponent
// fails to reveal in time. Settlement burns the lottery token, ending the game.

pub type LotteryDatum {
  player1: VerificationKeyHash,
  player2: VerificationKeyHash,
  commit1: ByteArray,
  commit2: ByteArray,
  // Empty bytes ("") = not yet revealed. Sentinel rather than Option to
  // keep the datum flat and cheap to compare on-chain.
  n1: ByteArray,
  n2: ByteArray,
  end_reveal: Int,
  // Grace period after end_reveal during which P2 can still reveal even if
  // they didn't make the initial window — once end_reveal+delta passes,
  // P1 can claim by Timeout2.
  delta: Int,
}

pub type LotteryRedeemer {
  Reveal1 { n1: ByteArray }
  Reveal2 { n2: ByteArray }
  Timeout1
  Timeout2
  Settle
}

validator lottery(policy_id: PolicyId, _game_index: Int) {
  spend(
    _datum_opt: Option<Data>,
    redeemer: LotteryRedeemer,
    oref: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      tx

    expect Some(own_input) =
      inputs_with_policy(inputs, policy_id) |> find_input(oref)
    expect InlineDatum(datum) = own_input.output.datum

    expect LotteryDatum {
      player1,
      player2,
      commit1,
      commit2,
      n1,
      n2,
      end_reveal,
      delta,
    } = datum

    // True iff no output continues this script — i.e. the lottery UTxO is
    // being closed out. Reveal steps require this to be False (they must
    // rebuild the state UTxO via reference-input observation off-chain);
    // settlement/timeout require it to be True.
    let script_utxo_consumed =
      (
        outputs
          |> list.filter(fn(o) { o.address == own_input.output.address })
          |> list.length
      ) == 0

    when redeemer is {
      // Reveal1 — P1 publishes their number. Must be first (n1 == ""),
      // hash must match commit1, and the state UTxO must continue.
      Reveal1 { n1: r1 } ->
        key_signed(extra_signatories, player1) && n1 == "" && r1 != "" && blake2b_256(
          r1,
        ) == commit1 && (!script_utxo_consumed)?

      // Reveal2 — P2 publishes only after P1 has (n1 != "" enforces order).
      // This is the anti-grinding clause: P2 sees commit1 but not n1 until
      // P1 reveals, so they can't tailor n2 to win.
      Reveal2 { n2: r2 } ->
        key_signed(extra_signatories, player2) && n1 != "" && n2 == "" && r2 != "" && blake2b_256(
          r2,
        ) == commit2 && (!script_utxo_consumed)?

      // Timeout1 — P1 never revealed by end_reveal. P2 takes the pot and
      // the lottery token is burned to close the game.
      Timeout1 ->
        n1 == "" && valid_after(validity_range, end_reveal)? && key_signed(
          extra_signatories,
          player2,
        )? && script_utxo_consumed? && only_minted_token(
          tx.mint,
          policy_id,
          "LOTTERY_TOKEN",
          -1,
        )

      // Timeout2 — P1 revealed but P2 didn't, even after the +delta grace.
      // P1 takes the pot. Extra delta exists so P2 isn't penalised by a
      // chain reorg / mempool race in the final slots before end_reveal.
      Timeout2 ->
        n1 != "" && n2 == "" && valid_after(validity_range, end_reveal + delta) && key_signed(
          extra_signatories,
          player1,
        ) && script_utxo_consumed && only_minted_token(
          tx.mint,
          policy_id,
          "LOTTERY_TOKEN",
          -1,
        )

      // Settle — both numbers revealed; parity of the sum picks the winner.
      // Only the winner can sign (the loser would never trigger this), and
      // the lottery token must be burned to retire the game.
      Settle -> {
        let both_revealed = n1 != "" && n2 != ""

        expect Some(v1) = int.from_utf8(n1)
        expect Some(v2) = int.from_utf8(n2)

        let winner =
          if ( v1 + v2 ) % 2 == 1 {
            player1
          } else {
            player2
          }

        both_revealed && key_signed(extra_signatories, winner) && script_utxo_consumed && only_minted_token(
          tx.mint,
          policy_id,
          "LOTTERY_TOKEN",
          -1,
        )
      }
    }
  }

  else(_) {
    fail
  }
}
