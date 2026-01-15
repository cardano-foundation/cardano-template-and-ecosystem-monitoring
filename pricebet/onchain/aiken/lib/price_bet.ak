use aiken/hash.{Blake2b_224, Hash}
use aiken/interval
use aiken/list
use aiken/option
use aiken/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input
}
use aiken/transaction/credential.{VerificationKey, from_verification_key}
use aiken/transaction/value
use oracle_datum.{OracleDatum}

pub type PriceBetDatum {
  owner: Hash<Blake2b_224, VerificationKey>,
  player: Option<Hash<Blake2b_224, VerificationKey>>,
  target_rate: Int,
  deadline: Int,
  bet_amount: Int,
}

pub type PriceBetRedeemer {
  Join
  Win
  Timeout
}

pub fn validate_bet(
  datum: PriceBetDatum,
  redeemer: PriceBetRedeemer,
  context: OutputReference,
  transaction: Transaction,
) -> Bool {
  let Transaction {
    inputs,
    outputs,
    extra_signatories,
    validity_range,
    reference_inputs,
    ..
  } = transaction

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

      // 4. Find the input being spent to know the total pot
      expect Some(own_input) = find_input(inputs, context)
      let total_pot = own_input.output.value

      // 5. Player wins if price > target_rate
      // 6. Must also ensure payout goes to the player
      let payout_to_player = list.any(outputs, fn(out) {
        out.address == from_verification_key(player) &&
        value.lovelace_of(out.value) >= value.lovelace_of(total_pot)
      })

      and {
        (current_price >= datum.target_rate)?,
        payout_to_player?,
        // Must happen before deadline? Actually Win can happen anytime as long as we have oracle data...
        // But usually there is a window. For now let's say anytime before/after is fine as long as target hit.
      }
    }

    Timeout -> {
      // 1. Must be after deadline
      let is_after_deadline =
        when validity_range.lower_bound.bound_type is {
          interval.Finite(tx_lower) -> tx_lower > datum.deadline
          _ -> False
        }

      // 2. Must be signed by owner
      let signed_by_owner = list.has(extra_signatories, datum.owner)

      // 3. Payout must go to owner
      expect Some(own_input) = find_input(inputs, context)
      let total_pot = own_input.output.value

      let payout_to_owner = list.any(outputs, fn(out) {
        out.address == from_verification_key(datum.owner) &&
        value.lovelace_of(out.value) >= value.lovelace_of(total_pot)
      })

      and {
        is_after_deadline?,
        signed_by_owner?,
        payout_to_owner?,
      }
    }
  }
}
