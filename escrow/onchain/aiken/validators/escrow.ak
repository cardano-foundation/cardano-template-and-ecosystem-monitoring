use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, from_asset_list, merge}
use cardano/transaction.{InlineDatum, OutputReference, Transaction, find_input}
use cocktail/vodka_address.{address_pub_key}
use cocktail/vodka_extra_signatories.{all_key_signed, key_signed, one_of_keys_signed}
use cocktail/vodka_inputs.{inputs_at}
use cocktail/vodka_outputs.{outputs_at}
use cocktail/vodka_value.{get_all_value_to, value_geq}

// Two-party asset swap with explicit recipient opt-in.
// Lifecycle: Initiation (initiator locks their side) -> ActiveEscrow (recipient
// deposits their side and is named in the datum) -> CompleteTrade (atomic
// swap to both addresses) or CancelTrade (return funds). The datum carries
// both addresses and asset bundles; no third-party arbitration.

pub type MValue =
  Pairs<PolicyId, Pairs<AssetName, Int>>

pub type EscrowDatum {
  Initiation { initiator: Address, initiator_assets: MValue }
  ActiveEscrow {
    initiator: Address,
    initiator_assets: MValue,
    recipient: Address,
    recipient_assets: MValue,
  }
}

pub type EscrowRedeemer {
  RecipientDeposit { recipient: Address, recipient_assets: MValue }
  CancelTrade
  CompleteTrade
}

validator escrow {
  spend(
    _datum: Option<EscrowDatum>,
    redeemer: EscrowRedeemer,
    input: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, .. } = tx
    expect Some(own_input) = find_input(inputs, input)
    let own_address = own_input.output.address
    when redeemer is {
      // RecipientDeposit — transition Initiation -> ActiveEscrow. Anyone can
      // call this (no signature check): the redeemer names the recipient,
      // and value_geq forces them to put up their side. Initiator's side
      // must remain locked unchanged.
      RecipientDeposit { recipient, recipient_assets } -> {
        expect ([input], [output]) =
          (inputs_at(inputs, own_address), outputs_at(outputs, own_address))
        expect InlineDatum(raw_input_datum) = input.output.datum
        expect InlineDatum(raw_output_datum) = output.datum
        expect Initiation { initiator, initiator_assets }: EscrowDatum =
          raw_input_datum
        expect ActiveEscrow {
          initiator: out_initiator,
          recipient: out_recipient,
          initiator_assets: out_initiator_assets,
          recipient_assets: out_recipient_assets,
        }: EscrowDatum = raw_output_datum

        let is_initiator_correct = out_initiator == initiator
        let is_recipient_correct = out_recipient == recipient

        let is_initiator_assets_correct =
          ( out_initiator_assets |> from_asset_list ) == (
            initiator_assets |> from_asset_list
          )

        let is_recipient_assets_correct =
          ( out_recipient_assets |> from_asset_list ) == (
            recipient_assets |> from_asset_list
          )

        // >= rather than ==: extra ada riding along is fine, what matters is
        // the recipient's bundle being fully present in addition to what
        // was already locked.
        let is_value_deposited =
          value_geq(
            output.value,
            input.output.value
              |> merge(recipient_assets |> from_asset_list()),
          )
        is_initiator_correct && is_recipient_correct && is_initiator_assets_correct && is_recipient_assets_correct && is_value_deposited
      }
      // CancelTrade — unwind. Two regimes:
      //   Initiation: only the initiator deposited; their signature alone
      //     suffices to reclaim.
      //   ActiveEscrow: both sides committed assets; either party can
      //     trigger the unwind, but the tx must repay BOTH sides their
      //     original deposits — preventing one party from canceling and
      //     pocketing the other's funds.
      CancelTrade -> {
        expect ([input], []) =
          (inputs_at(inputs, own_address), outputs_at(outputs, own_address))
        expect InlineDatum(raw_input_datum) = input.output.datum
        expect input_datum: EscrowDatum = raw_input_datum
        when input_datum is {
          Initiation { initiator, .. } -> {
            expect Some(pub_key) = address_pub_key(initiator)
            key_signed(extra_signatories, pub_key)
          }

          ActiveEscrow {
            initiator,
            recipient,
            initiator_assets,
            recipient_assets,
          } -> {
            let initiator_received = get_all_value_to(outputs, initiator)
            let recipient_received = get_all_value_to(outputs, recipient)
            let is_initiator_received_value =
              value_geq(
                initiator_received,
                initiator_assets |> from_asset_list(),
              )
            let is_recipient_received_value =
              value_geq(
                recipient_received,
                recipient_assets |> from_asset_list(),
              )
            expect Some(initiator_pub_key) = address_pub_key(initiator)
            expect Some(recipient_pub_key) = address_pub_key(recipient)
            let is_any_party_signed =
              one_of_keys_signed(
                extra_signatories,
                [initiator_pub_key, recipient_pub_key],
              )
            is_any_party_signed && is_initiator_received_value && is_recipient_received_value
          }
        }
      }
      // CompleteTrade — atomic swap. Requires BOTH signatures (neither party
      // can force settlement) and crosses the asset bundles: initiator
      // receives recipient_assets, recipient receives initiator_assets.
      CompleteTrade -> {
        expect ([input], []) =
          (inputs_at(inputs, own_address), outputs_at(outputs, own_address))
        expect InlineDatum(raw_input_datum) = input.output.datum
        expect ActiveEscrow {
          initiator,
          recipient,
          initiator_assets,
          recipient_assets,
        }: EscrowDatum = raw_input_datum
        let initiator_received = get_all_value_to(outputs, initiator)
        let recipient_received = get_all_value_to(outputs, recipient)
        let is_initiator_received_value =
          value_geq(initiator_received, recipient_assets |> from_asset_list())
        let is_recipient_received_value =
          value_geq(recipient_received, initiator_assets |> from_asset_list())
        expect Some(initiator_pub_key) = address_pub_key(initiator)
        expect Some(recipient_pub_key) = address_pub_key(recipient)
        let is_both_parties_signed =
          all_key_signed(
            extra_signatories,
            [initiator_pub_key, recipient_pub_key],
          )
        is_both_parties_signed && is_initiator_received_value && is_recipient_received_value
      }
    }
  }

  else(_) {
    fail
  }
}
