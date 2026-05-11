use aiken/crypto.{VerificationKeyHash, sha2_256}
use cardano/transaction.{OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_validity_range.{valid_after, valid_before}

// Hash-Timelock Contract. Owner locks funds against a sha2_256 preimage and
// an expiry; either anyone-who-knows-the-secret claims via GUESS, or the
// owner reclaims after expiry via WITHDRAW. The hash itself is a validator
// parameter (not a datum) so each HTLC instance has its own script hash and
// the secret never appears on-chain pre-reveal.

pub type Htlc {
  GUESS { answer: ByteArray }
  WITHDRAW
}

validator htlc(secret: ByteArray, expiration: Int, owner: VerificationKeyHash) {
  spend(
    _datum: Option<Data>,
    redeemer: Htlc,
    _utxo: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { extra_signatories, validity_range, .. } = tx
    when redeemer is {
      // GUESS — preimage check only. No signature or address constraints:
      // anyone who reveals a valid preimage can take the funds. In a cross-
      // chain HTLC the off-chain protocol decides who learns the secret.
      GUESS { answer } -> sha2_256(answer) == secret
      // WITHDRAW — owner refund after expiry. valid_after pins the tx
      // strictly after `expiration`, so a refund and a claim can never
      // both be valid in the same slot.
      WITHDRAW -> and {
          valid_after(validity_range, expiration),
          key_signed(extra_signatories, owner),
        }
    }
  }

  else(_) {
    fail
  }
}
