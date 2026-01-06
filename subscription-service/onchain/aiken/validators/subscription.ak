use aiken/collection/list
use aiken/interval.{Finite}
use cardano/address.{VerificationKey}
use cardano/assets.{lovelace_of, without_lovelace}
use cardano/transaction.{
  InlineDatum, Input, OutputReference, Transaction,
}
use types.{Cancel, Close, Collect, SubscriptionAction, SubscriptionDatum}

validator subscription {
  spend(
    datum: Option<Data>,
    redeemer: Data,
    utxo: OutputReference,
    self: Transaction,
  ) {
    expect Some(datum) = datum
    expect datum: SubscriptionDatum = datum
    expect redeemer: SubscriptionAction = redeemer

    when redeemer is {
      Collect -> {
        expect True = list.has(self.extra_signatories, datum.merchant)

        expect Finite(lower_bound) = self.validity_range.lower_bound.bound_type
        expect True = lower_bound >= datum.last_claim + datum.period

        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == utxo })

        expect Some(own_output) =
          list.find(
            self.outputs,
            fn(output) { output.address == own_input.output.address },
          )

        expect InlineDatum(output_datum_data) = own_output.datum
        expect output_datum: SubscriptionDatum = output_datum_data

        and {
          output_datum.merchant == datum.merchant,
          output_datum.subscriber == datum.subscriber,
          output_datum.fee == datum.fee,
          output_datum.period == datum.period,
          output_datum.last_claim == lower_bound,
          lovelace_of(own_output.value) == lovelace_of(own_input.output.value) - datum.fee,
          without_lovelace(own_output.value) == without_lovelace(
            own_input.output.value,
          ),
        }
      }
      Cancel -> list.has(self.extra_signatories, datum.subscriber)
      Close -> {
        expect True = list.has(self.extra_signatories, datum.merchant)
        
        expect Some(own_input) =
          list.find(self.inputs, fn(input) { input.output_reference == utxo })
          
        // Merchant must demonstrate they are returning the remaining value to the subscriber
        list.any(
          self.outputs,
          fn(output) {
            and {
              output.address.payment_credential == VerificationKey(
                datum.subscriber,
              ),
              lovelace_of(output.value) >= lovelace_of(own_input.output.value),
              without_lovelace(output.value) == without_lovelace(
                 own_input.output.value,
               ),
            }
          },
        )
      }
    }
  }

  else(_) {
    fail
  }
}
