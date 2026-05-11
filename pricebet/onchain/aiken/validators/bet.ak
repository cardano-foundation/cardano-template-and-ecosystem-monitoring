use cardano/transaction.{OutputReference, Transaction}
use price_bet.{PriceBetDatum, PriceBetRedeemer, validate_bet}

// Thin spend entry-point. The real logic lives in lib/price_bet.ak so it can
// be reused (and unit-tested via price_bet_test.ak) without going through a
// validator boundary. A missing datum is unconditionally rejected — this
// script only ever handles fully-typed bet UTxOs.
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

