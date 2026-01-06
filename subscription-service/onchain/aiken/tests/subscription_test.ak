use aiken/interval
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address, VerificationKey}
use cardano/assets.{from_lovelace}
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, placeholder,
}
use types.{Cancel, Collect, SubscriptionDatum}
use validators/subscription

fn test_datum(
  merchant: VerificationKeyHash,
  subscriber: VerificationKeyHash,
  last_claim: Int,
) -> SubscriptionDatum {
  SubscriptionDatum {
    merchant,
    subscriber,
    fee: 1_000_000,
    last_claim,
    period: 86_400_000, // 1 day in ms
  }
}

test collect_success() {
  let merchant = #"01"
  let subscriber = #"02"
  let start_time = 1_000_000_000
  let period = 86_400_000
  let fee = 1_000_000
  let current_time = start_time + period

  let datum = test_datum(merchant, subscriber, start_time)

  let input_value = from_lovelace(10_000_000)
  let output_value = from_lovelace(9_000_000) // 10 - 1

  let input_utxo = OutputReference { transaction_id: #"00", output_index: 0 }
  let script_credential = VerificationKey(#"99") // Simulating script
  let script_address =
    Address { payment_credential: script_credential, stake_credential: None }

  let input =
    Input {
      output_reference: input_utxo,
      output: Output {
        address: script_address,
        value: input_value,
        datum: InlineDatum(datum),
        reference_script: None,
      },
    }

  let updated_datum = SubscriptionDatum { ..datum, last_claim: current_time }

  let output =
    Output {
      address: script_address,
      value: output_value,
      datum: InlineDatum(updated_datum),
      reference_script: None,
    }

  let tx =
    Transaction {
      ..placeholder,
      inputs: [input],
      outputs: [output],
      extra_signatories: [merchant],
      validity_range: interval.after(current_time),
    }

  subscription.subscription.spend(Some(datum), Collect, input_utxo, tx)
}

test cancel_success() {
  let merchant = #"01"
  let subscriber = #"02"
  let start_time = 1_000_000_000
  
  let datum = test_datum(merchant, subscriber, start_time)
  let input_utxo = OutputReference { transaction_id: #"00", output_index: 0 }

  let tx =
    Transaction {
      ..placeholder,
      extra_signatories: [subscriber],
    }

  subscription.subscription.spend(Some(datum), Cancel, input_utxo, tx)
}
