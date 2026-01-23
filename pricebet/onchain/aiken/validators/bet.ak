use aiken/transaction.{OutputReference, Transaction}
use price_bet.{PriceBetDatum, PriceBetRedeemer, validate_bet}

validator bet {
  spend(
    datum: Option<PriceBetDatum>,
    redeemer: PriceBetRedeemer,
    context: OutputReference,
    transaction: Transaction,
  ) {
    expect Some(datum) = datum
    validate_bet(datum, redeemer, context, transaction)
  }
}

