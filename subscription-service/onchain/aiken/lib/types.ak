use aiken/crypto.{VerificationKeyHash}

pub type SubscriptionDatum {
  merchant: VerificationKeyHash,
  subscriber: VerificationKeyHash,
  fee: Int,
  last_claim: Int,
  period: Int,
}

pub type SubscriptionAction {
  /// Merchant collects the fee for the current period
  Collect
  /// Subscriber cancels the subscription and retrieves remaining funds
  Cancel
  /// Merchant terminates the subscription (must return funds to subscriber)
  Close
}
