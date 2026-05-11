use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use aiken/interval
use aiken/option
use cardano/address.{Script, from_verification_key}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input,
}
use oracle_datum.{OracleDatum}

// Oracle-resolved price bet. Owner stakes against a target rate by `deadline`;
// a player joins by matching the stake. At settlement an external oracle
// UTxO (referenced, not consumed) is consulted: if price >= target, player
// wins the pot; if the deadline passes without resolution, owner reclaims
// via Timeout. The oracle is identified by its script hash in the datum, so
// each bet pins which oracle it trusts.

pub type PriceBetDatum {
  owner: VerificationKeyHash,
  player: Option<VerificationKeyHash>,
  oracle_vkh: ScriptHash,
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
    // Join — match the owner's stake before the deadline. Rebuilds the
    // script UTxO with `player` set and all other fields unchanged; the
    // pot must be at least 2 * bet_amount.
    Join -> {
      expect datum.player == None

      expect Some(own_input) = find_input(inputs, context)

      let script_address = own_input.output.address
      let script_outputs =
        list.filter(outputs, fn(output) { output.address == script_address })
      expect [continuing_output] = script_outputs

      expect InlineDatum(data) = continuing_output.datum
      expect updated_datum: PriceBetDatum = data

      and {
        option.is_some(updated_datum.player)?,
        // The joining signer is literally the new player — prevents a third
        // party from forging someone else's participation.
        list.has(extra_signatories, option.or_else(updated_datum.player, #"" ))?,
        (updated_datum.owner == datum.owner)?,
        (updated_datum.oracle_vkh == datum.oracle_vkh)?,
        (updated_datum.target_rate == datum.target_rate)?,
        (updated_datum.deadline == datum.deadline)?,
        (updated_datum.bet_amount == datum.bet_amount)?,
        (assets.lovelace_of(continuing_output.value) >= 2 * datum.bet_amount)?,
        // Deadline check uses the tx upper bound: we want "tx happens
        // entirely before the deadline", not just "starts before".
        when validity_range.upper_bound.bound_type is {
          interval.Finite(tx_upper) -> (tx_upper <= datum.deadline)?
          _ -> False
        },
      }
    }

    // Win — player claims the pot. Oracle UTxO is taken as a reference
    // input so multiple bets can read the same oracle UTxO concurrently
    // without consuming it. Price must clear the target, the oracle's own
    // validity must still cover the tx upper bound (no stale prices), and
    // we must still be before the bet deadline.
    Win -> {
      expect Some(player) = datum.player

      expect list.has(extra_signatories, player)

      let oracle_input =
        list.find(
          reference_inputs,
          fn(input) {
            let addr = input.output.address
            when addr.payment_credential is {
              Script(vh) -> vh == datum.oracle_vkh
              _ -> False
            }
          },
        )

      expect Some(input) = oracle_input
      expect InlineDatum(d) = input.output.datum
      expect oracle: OracleDatum = d

      let current_price = oracle_datum.get_oracle_price(oracle)

      expect Some(own_input) = find_input(inputs, context)
      let total_pot = own_input.output.value

      // Payout uses the input's full value as a lower bound. Player can
      // pile on extra ada (e.g. min-utxo padding) but cannot drain.
      let payout_to_player = list.any(outputs, fn(out) {
        out.address == from_verification_key(player) &&
        assets.lovelace_of(out.value) >= assets.lovelace_of(total_pot)
      })

      let is_price_valid = when validity_range.upper_bound.bound_type is {
        interval.Finite(tx_upper) -> oracle_datum.is_oracle_valid(oracle, tx_upper)
        _ -> False
      }

      and {
        (current_price >= datum.target_rate)?,
        is_price_valid?,
        payout_to_player?,
        when validity_range.upper_bound.bound_type is {
          interval.Finite(tx_upper) -> (tx_upper <= datum.deadline)?
          _ -> False
        },
      }
    }

    // Timeout — owner reclaim after the deadline. lower_bound > deadline
    // forces the tx to start strictly past the deadline, so Win and Timeout
    // can never both validate in the same slot.
    Timeout -> {
      let is_after_deadline =
        when validity_range.lower_bound.bound_type is {
          interval.Finite(tx_lower) -> tx_lower > datum.deadline
          _ -> False
        }

      let signed_by_owner = list.has(extra_signatories, datum.owner)

      expect Some(own_input) = find_input(inputs, context)
      let total_pot = own_input.output.value

      let payout_to_owner = list.any(outputs, fn(out) {
        out.address == from_verification_key(datum.owner) &&
        assets.lovelace_of(out.value) >= assets.lovelace_of(total_pot)
      })

      and {
        is_after_deadline?,
        signed_by_owner?,
        payout_to_owner?,
      }
    }
  }
}
