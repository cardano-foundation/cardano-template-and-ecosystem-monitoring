use aiken/collection/list
use aiken/crypto.{VerificationKeyHash, blake2b_256}
use aiken/primitive/int
use cardano/address.{VerificationKey}
use cardano/assets.{lovelace_of}
use cardano/transaction.{InlineDatum, OutputReference, Transaction, find_input}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_validity_range.{valid_after}
use cocktail/vodka_value.{outputs_value}

pub type LotteryDatum {
  player1: VerificationKeyHash,
  player2: VerificationKeyHash,
  commit1: ByteArray,
  commit2: ByteArray,
  n1: ByteArray,
  // "" = not revealed
  n2: ByteArray,
  // "" = not revealed
  end_reveal: Int,
  delta: Int,
}

pub type LotteryRedeemer {
  Reveal1 { n1: ByteArray }
  Reveal2 { n2: ByteArray }
  Timeout1
  Timeout2
  Settle
}

validator lottery (_game_index: Int){
  spend(
    _datum_opt: Option<Data>,
    // ignored on purpose
    redeemer: LotteryRedeemer,
    oref: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      tx

    // 1. Locate the script input
    expect Some(own_input) = find_input(inputs, oref)

    // 2. Extract inline datum (the state)
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

    let pays_to =
      fn(pkh) {
        let locked = lovelace_of(own_input.output.value)

        let paid_to_pkh =
          outputs
            |> list.filter(
                fn(o) { o.address.payment_credential == VerificationKey(pkh) },
              )
            |> outputs_value
            |> lovelace_of
        trace @"foo": paid_to_pkh
        trace @"foo": locked

        paid_to_pkh == locked
      }

    when redeemer is {
      // ---------- Player 1 reveal ----------
      Reveal1 { n1: r1 } ->
        key_signed(extra_signatories, player1) && n1 == "" && r1 != "" && blake2b_256(
          r1,
        ) == commit1

      // ---------- Player 2 reveal ----------
      Reveal2 { n2: r2 } ->
        key_signed(extra_signatories, player2) && n1 != "" && n2 == "" && r2 != "" && blake2b_256(
          r2,
        ) == commit2

      // ---------- Timeout: player2 wins ----------
      Timeout1 ->
        n1 == "" && valid_after(validity_range, end_reveal)? && key_signed(
          extra_signatories,
          player2,
        )? && pays_to(player2)?

      // ---------- Timeout: player1 wins ----------
      Timeout2 ->
        n1 != "" && n2 == "" && valid_after(validity_range, end_reveal + delta) && key_signed(
          extra_signatories,
          player1,
        ) && pays_to(player1)

      // ---------- Final settlement ----------
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

        both_revealed && key_signed(extra_signatories, winner) && pays_to(
          winner,
        )
      }
    }
  }

  else(_) {
    fail
  }
}
