use aiken/interval
use aiken/transaction.{InlineDatum, Input, Output, OutputReference, Transaction, placeholder, TransactionId}
use aiken/transaction/credential.{from_verification_key}
use aiken/transaction/value
use oracle_datum
use price_bet.{PriceBetDatum, Join, Win, Timeout}

test join_success() {
  let owner_vkh = #"01010101010101010101010101010101010101010101010101010101"
  let player_vkh = #"02020202020202020202020202020202020202020202020202020202"
  let bet_amount = 10000000 // 10 ADA
  
  let initial_datum = PriceBetDatum {
    owner: owner_vkh,
    player: None,
    oracle_vkh: #"ffff",
    target_rate: 1500,
    deadline: 1000,
    bet_amount,
  }

  let updated_datum = PriceBetDatum { 
    ..initial_datum, 
    player: Some(player_vkh) 
  }

  let utxo_ref = OutputReference {
    transaction_id: TransactionId { hash: #"0000000000000000000000000000000000000000000000000000000000000000" },
    output_index: 0,
  }

  let script_address = from_verification_key(#"aa")

  let transaction = Transaction {
    ..placeholder(),
    inputs: [
      Input {
        output_reference: utxo_ref,
        output: Output {
          address: script_address,
          value: value.from_lovelace(bet_amount),
          datum: InlineDatum(initial_datum),
          reference_script: None,
        }
      }
    ],
    outputs: [
      Output {
        address: script_address,
        value: value.from_lovelace(2 * bet_amount),
        datum: InlineDatum(updated_datum),
        reference_script: None,
      }
    ],
    extra_signatories: [player_vkh],
    validity_range: interval.between(0, 500),
  }

  price_bet.price_bet.spend(Some(initial_datum), Join, utxo_ref, transaction)
}

test win_success() {
  let player_vkh = #"02020202020202020202020202020202020202020202020202020202"
  let datum = PriceBetDatum {
    owner: #"0101",
    player: Some(player_vkh),
    oracle_vkh: #"ffff",
    target_rate: 1500,
    deadline: 2000,
    bet_amount: 10000000,
  }

  let oracle_datum_data = oracle_datum.create_oracle_datum(1600, 1000, 3000)

  let reference_input = Input {
    output_reference: OutputReference {
      transaction_id: TransactionId { hash: #"0000000000000000000000000000000000000000000000000000000000000000" },
      output_index: 0,
    },
    output: Output {
      address: from_verification_key(#"ee"),
      value: value.from_lovelace(2000000),
      datum: InlineDatum(oracle_datum_data),
      reference_script: None,
    },
  }

  let transaction = Transaction {
    ..placeholder(),
    extra_signatories: [player_vkh],
    reference_inputs: [reference_input],
    validity_range: interval.between(1000, 1500),
  }

  price_bet.price_bet.spend(Some(datum), Win, OutputReference {
    transaction_id: TransactionId { hash: #"1111111111111111111111111111111111111111111111111111111111111111" },
    output_index: 0,
  }, transaction)
}

test timeout_success() {
  let owner_vkh = #"01010101010101010101010101010101010101010101010101010101"
  let datum = PriceBetDatum {
    owner: owner_vkh,
    player: Some(#"0202"),
    oracle_vkh: #"ffff",
    target_rate: 1500,
    deadline: 1000,
    bet_amount: 10000000,
  }

  let transaction = Transaction {
    ..placeholder(),
    extra_signatories: [owner_vkh],
    validity_range: interval.after(1001),
  }

  price_bet.price_bet.spend(Some(datum), Timeout, OutputReference {
    transaction_id: TransactionId { hash: #"1111" },
    output_index: 0,
  }, transaction)
}
