use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets
use cardano/transaction.{
  InlineDatum, NoDatum, Output, OutputReference, Transaction, find_input,
}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_validity_range.{valid_after}

// Time-locked vault with a two-step withdrawal. Lifecycle:
//   WITHDRAW: owner schedules a withdrawal by stamping the UTxO with a
//     lock_time. Funds stay in the contract; a datum-bearing output rebuilds
//     the locked state, a datum-less output drains.
//   FINALIZE: after lock_time + waitTime, owner can actually take the funds.
//   CANCEL: owner aborts a scheduled withdrawal, reverting to a datum-less
//     UTxO so the next withdrawal must restart the clock.
// waitTime is a script parameter so every vault has a known cool-down baked
// into its address.

pub type Action {
  WITHDRAW
  FINALIZE
  CANCEL
}

pub type WithdrawDatum {
  lock_time: Int,
}

validator vault(owner: VerificationKeyHash, waitTime: Int) {
  spend(
    datum: Option<WithdrawDatum>,
    redeemer: Action,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      self
    when redeemer is {
      // WITHDRAW — schedule (or re-schedule) a withdrawal. Conservation:
      // total lovelace returning to the script must equal what was input.
      // Each datum-bearing continuing output's lock_time must already be
      // in the past, so the owner cannot push the clock backwards by
      // re-scheduling with an earlier lock_time after waiting.
      WITHDRAW -> {
        expect Some(spent_utxo) = find_input(inputs, utxo)
        let output_back_to_contract =
          outputs
            |> list.filter(fn(out) { out.address == spent_utxo.output.address })
            |> list.map(fn(o) { assets.lovelace_of(o.value) })
            |> list.foldr(0, fn(n, total) { n + total })
        outputs
          |> list.filter(
              fn(out) {
                out.address == spent_utxo.output.address && out.datum != NoDatum
              },
            )
          |> list.for_each(
              fn(o) {
                expect InlineDatum(inline_datum) = o.datum
                expect WithdrawDatum { lock_time } = inline_datum
                expect valid_after(validity_range, lock_time)
              },
            )
        and {
          output_back_to_contract == assets.lovelace_of(spent_utxo.output.value),
          key_signed(extra_signatories, owner),
        }
      }

      // FINALIZE — collect the funds. Tx must start strictly after
      // lock_time + waitTime, which is the full cool-down. No output checks
      // here: once the timer elapses the owner has unconditional access.
      FINALIZE -> {
        expect Some(withdraw_datum) = datum
        and {
          key_signed(extra_signatories, owner),
          valid_after(self.validity_range, waitTime + withdraw_datum.lock_time),
        }
      }

      // CANCEL — abort the scheduled withdrawal. Funds stay in the vault
      // (same conservation rule as WITHDRAW); off-chain side is expected to
      // re-deposit them as a datum-less UTxO so the timer is reset.
      CANCEL -> {
        expect Some(spent_utxo) = find_input(inputs, utxo)

        let output_back_to_contract =
          outputs
            |> list.filter(fn(out) { out.address == spent_utxo.output.address })
            |> list.map(fn(o) { assets.lovelace_of(o.value) })
            |> list.foldr(0, fn(n, total) { n + total })
        and {
          output_back_to_contract == assets.lovelace_of(spent_utxo.output.value),
          key_signed(extra_signatories, owner),
        }
      }
    }
  }

  else(_) {
    fail
  }
}
