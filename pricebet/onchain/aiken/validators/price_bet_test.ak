use aiken/interval
use cardano/address.{Address, Script, from_verification_key}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction, placeholder,
}
use oracle_datum
use price_bet.{Join, PriceBetDatum, Timeout, Win, validate_bet}

const zero_tx_hash: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000000"

const one_tx_hash: ByteArray =
  #"1111111111111111111111111111111111111111111111111111111111111111"

test join_success() {
  let owner_vkh = #"01010101010101010101010101010101010101010101010101010101"
  let player_vkh = #"02020202020202020202020202020202020202020202020202020202"
  let oracle_vkh = #"03030303030303030303030303030303030303030303030303030303"
  let bet_amount = 10000000

  let initial_datum =
    PriceBetDatum {
      owner: owner_vkh,
      player: None,
      oracle_vkh,
      target_rate: 1500,
      deadline: 1000,
      bet_amount,
    }

  let updated_datum =
    PriceBetDatum { ..initial_datum, player: Some(player_vkh) }

  let utxo_ref =
    OutputReference { transaction_id: zero_tx_hash, output_index: 0 }

  let script_address = from_verification_key(#"aa")

  let transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output_reference: utxo_ref,
          output: Output {
            address: script_address,
            value: assets.from_lovelace(bet_amount),
            datum: InlineDatum(initial_datum),
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: script_address,
          value: assets.from_lovelace(2 * bet_amount),
          datum: InlineDatum(updated_datum),
          reference_script: None,
        },
      ],
      extra_signatories: [player_vkh],
      validity_range: interval.between(0, 500),
    }

  validate_bet(initial_datum, Join, utxo_ref, transaction)
}

test win_success() {
  let player_vkh = #"02020202020202020202020202020202020202020202020202020202"
  let oracle_vkh = #"03030303030303030303030303030303030303030303030303030303"
  let bet_amount = 10000000
  let datum =
    PriceBetDatum {
      owner: #"0101",
      player: Some(player_vkh),
      oracle_vkh,
      target_rate: 1500,
      deadline: 2000,
      bet_amount,
    }

  let oracle_datum_data = oracle_datum.create_oracle_datum(1600, 1000, 3000)

  let reference_input =
    Input {
      output_reference: OutputReference {
        transaction_id: zero_tx_hash,
        output_index: 0,
      },
      output: Output {
        address: Address {
          payment_credential: Script(oracle_vkh),
          stake_credential: None,
        },
        value: assets.from_lovelace(2000000),
        datum: InlineDatum(oracle_datum_data),
        reference_script: None,
      },
    }

  let utxo_ref =
    OutputReference { transaction_id: one_tx_hash, output_index: 0 }

  let script_address = from_verification_key(#"aa")

  let transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output_reference: utxo_ref,
          output: Output {
            address: script_address,
            value: assets.from_lovelace(2 * bet_amount),
            datum: InlineDatum(datum),
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: from_verification_key(player_vkh),
          value: assets.from_lovelace(2 * bet_amount),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [player_vkh],
      reference_inputs: [reference_input],
      validity_range: interval.between(1000, 1500),
    }

  validate_bet(datum, Win, utxo_ref, transaction)
}

test timeout_success() {
  let owner_vkh = #"01010101010101010101010101010101010101010101010101010101"
  let oracle_vkh = #"03030303030303030303030303030303030303030303030303030303"
  let bet_amount = 10000000
  let datum =
    PriceBetDatum {
      owner: owner_vkh,
      player: Some(#"0202"),
      oracle_vkh,
      target_rate: 1500,
      deadline: 1000,
      bet_amount,
    }

  let utxo_ref =
    OutputReference { transaction_id: one_tx_hash, output_index: 0 }

  let script_address = from_verification_key(#"aa")

  let transaction =
    Transaction {
      ..placeholder,
      inputs: [
        Input {
          output_reference: utxo_ref,
          output: Output {
            address: script_address,
            value: assets.from_lovelace(2 * bet_amount),
            datum: InlineDatum(datum),
            reference_script: None,
          },
        },
      ],
      outputs: [
        Output {
          address: from_verification_key(owner_vkh),
          value: assets.from_lovelace(2 * bet_amount),
          datum: NoDatum,
          reference_script: None,
        },
      ],
      extra_signatories: [owner_vkh],
      validity_range: interval.after(1001),
    }

  validate_bet(datum, Timeout, utxo_ref, transaction)
}
