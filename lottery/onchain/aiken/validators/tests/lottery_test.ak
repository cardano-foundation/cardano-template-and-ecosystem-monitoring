use aiken/crypto.{blake2b_256}
use cardano/assets.{from_lovelace}
use cardano/transaction.{InlineDatum, Input, Output}
use lottery.{LotteryDatum, Reveal1, Reveal2, Settle, Timeout1, Timeout2}
use mocktail.{
  add_input, complete, invalid_before, mocktail_tx, required_signer_hash, tx_out,
}
use mocktail/virgin_address.{mock_pub_key_address, mock_script_address}
use mocktail/virgin_key_hash.{mock_pub_key_hash}
use mocktail/virgin_output_reference.{mock_utxo_ref}

// --------------------------------------------------
// Shared test constants
// --------------------------------------------------

const player1 = mock_pub_key_hash(1)

const player2 = mock_pub_key_hash(2)

const script_addr = mock_script_address(3, None)

// secrets as UTF-8 ByteArray
const n1 = "3"

// odd
const n2 = "4"

// even

const commit1 = blake2b_256(n1)

const commit2 = blake2b_256(n2)

const end_reveal = 100

const delta = 20

const player1_addr = mock_pub_key_address(1, None)

const player2_addr = mock_pub_key_address(2, None)

const initial_datum =
  LotteryDatum {
    player1,
    player2,
    commit1,
    commit2,
    n1: "",
    n2: "",
    end_reveal,
    delta,
  }

fn script_input(oref, datum) {
  Input {
    output_reference: oref,
    output: Output {
      address: script_addr,
      value: from_lovelace(10_000_000),
      datum: InlineDatum(datum),
      reference_script: None,
    },
  }
}

test reveal1_valid() {
  let oref = mock_utxo_ref(0, 0)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, player1)
      |> complete()
      |> add_input(True, script_input(oref, initial_datum))

  lottery.lottery.spend(1, None, Reveal1 { n1 }, oref, tx)
}

test reveal1_invalid_wrong_signer() {
  let oref = mock_utxo_ref(0, 0)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, player2)
      |> complete()
      |> add_input(True, script_input(oref, initial_datum))

  !lottery.lottery.spend(1, None, Reveal1 { n1 }, oref, tx)
}

test timeout1_valid_player2_wins() {
  let oref = mock_utxo_ref(0, 0)

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, player2)
      |> tx_out(True, player2_addr, from_lovelace(10_000_000))
      |> invalid_before(True, end_reveal + 1)
      |> complete()
      |> add_input(True, script_input(oref, initial_datum))

  lottery.lottery.spend(1, None, Timeout1, oref, tx)
}

test settle_valid_player1_wins() {
  let oref = mock_utxo_ref(0, 0)

  let revealed_datum =
    LotteryDatum {
      player1,
      player2,
      commit1,
      commit2,
      n1,
      n2,
      end_reveal,
      delta,
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, player1)
      |> tx_out(True, player1_addr, from_lovelace(10_000_000))
      |> complete()
      |> add_input(True, script_input(oref, revealed_datum))

  lottery.lottery.spend(1, None, Settle, oref, tx)
}

test reveal2_valid() {
  let oref = mock_utxo_ref(0, 0)

  let revealed1_datum =
    LotteryDatum {
      player1,
      player2,
      commit1,
      commit2,
      n1,
      n2: "",
      end_reveal,
      delta,
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, player2)
      |> complete()
      |> add_input(True, script_input(oref, revealed1_datum))

  lottery.lottery.spend(1, None, Reveal2 { n2 }, oref, tx)
}

test timeout2_valid_player1_wins() {
  let oref = mock_utxo_ref(0, 0)

  let revealed1_datum =
    LotteryDatum {
      player1,
      player2,
      commit1,
      commit2,
      n1,
      n2: "",
      end_reveal,
      delta,
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, player1)
      |> tx_out(True, player1_addr, from_lovelace(10_000_000))
      |> invalid_before(True, end_reveal + delta + 1)
      |> complete()
      |> add_input(True, script_input(oref, revealed1_datum))

  lottery.lottery.spend(1, None, Timeout2, oref, tx)
}

test settle_invalid_wrong_winner() {
  let oref = mock_utxo_ref(0, 0)

  let revealed_datum =
    LotteryDatum {
      player1,
      player2,
      commit1,
      commit2,
      n1,
      n2,
      end_reveal,
      delta,
    }

  let tx =
    mocktail_tx()
      |> required_signer_hash(True, player2)
      |> tx_out(True, mock_script_address(0, None), from_lovelace(10_000_000))
      |> complete()
      |> add_input(True, script_input(oref, revealed_datum))

  !lottery.lottery.spend(1, None, Settle, oref, tx)
}
