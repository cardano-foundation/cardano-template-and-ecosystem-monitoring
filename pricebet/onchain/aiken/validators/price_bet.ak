use aiken/hash.{Blake2b_224, Hash}
use aiken/interval
use aiken/list
use aiken/option
use aiken/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input, placeholder, TransactionId
}
use aiken/transaction/credential.{VerificationKey, from_verification_key}
use aiken/transaction/value
use oracle_datum.{OracleDatum}

pub type PriceBetDatum {
  owner: Hash<Blake2b_224, VerificationKey>,
  player: Option<Hash<Blake2b_224, VerificationKey>>,
  oracle_vkh: Hash<Blake2b_224, VerificationKey>,
  target_rate: Int,
  deadline: Int,
  bet_amount: Int,
}

pub type PriceBetRedeemer {
  Join
  Win
  Timeout
}

validator price_bet {
  spend(
    datum: Option<PriceBetDatum>,
    redeemer: PriceBetRedeemer,
    context: OutputReference,
    transaction: Transaction,
  ) {
    let Transaction {
      inputs,
      outputs,
      extra_signatories,
      validity_range,
      reference_inputs,
      ..
    } = transaction

    expect Some(datum) = datum

    when redeemer is {
      Join -> {
        // 1. Must not already have a player
        expect datum.player == None

        // 2. Find the input being spent
        expect Some(own_input) = find_input(inputs, context)

        // 3. Find the continuing output
        let script_address = own_input.output.address
        let script_outputs =
          list.filter(outputs, fn(output) { output.address == script_address })
        expect [continuing_output] = script_outputs

        // 4. Validate output datum (updated with player)
        expect InlineDatum(data) = continuing_output.datum
        expect updated_datum: PriceBetDatum = data

        // 5. Check constraints
        and {
          // Player must be me
          option.is_some(updated_datum.player)?,
          // Signatory must match the new player
          list.has(extra_signatories, option.or_else(updated_datum.player, #"" ))?,
          // Other fields unchanged
          (updated_datum.owner == datum.owner)?,
          (updated_datum.oracle_vkh == datum.oracle_vkh)?,
          (updated_datum.target_rate == datum.target_rate)?,
          (updated_datum.deadline == datum.deadline)?,
          (updated_datum.bet_amount == datum.bet_amount)?,
          // Value must double (owner deposit + player deposit)
          (value.lovelace_of(continuing_output.value) >= 2 * datum.bet_amount)?,
          // Must happen before deadline
          when validity_range.upper_bound.bound_type is {
            interval.Finite(tx_upper) -> (tx_upper <= datum.deadline)?
            _ -> False
          },
        }
      }

      Win -> {
        // 1. Must have a player
        expect Some(player) = datum.player

        // 2. Must be signed by the player
        expect list.has(extra_signatories, player)

        // 3. Find oracle reference input
        let oracle_input =
          list.find(
            reference_inputs,
            fn(input) {
              when input.output.datum is {
                InlineDatum(_) -> True
                _ -> False
              }
            },
          )

        expect Some(input) = oracle_input
        expect InlineDatum(d) = input.output.datum
        expect oracle: OracleDatum = d

        let current_price = oracle_datum.get_oracle_price(oracle)

        // 4. Check win condition
        and {
          (current_price >= datum.target_rate)?,
          when validity_range.upper_bound.bound_type is {
            interval.Finite(tx_upper) -> (tx_upper <= datum.deadline)?
            _ -> False
          },
        }
      }

      Timeout -> {
        // 1. Signed by owner
        and {
          list.has(extra_signatories, datum.owner)?,
          // 2. Must be after deadline
          when validity_range.lower_bound.bound_type is {
            interval.Finite(tx_lower) -> (tx_lower > datum.deadline)?
            _ -> False
          },
        }
      }
    }
  }
}
