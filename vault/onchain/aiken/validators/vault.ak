use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets
use cardano/transaction.{
  InlineDatum, NoDatum, Output, OutputReference, Transaction, find_input,
}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_validity_range.{valid_after}

pub type Action {
  WITHDRAW
  FINALIZE
  CANCEL
}

pub type WithdrawDatum {
  lock_time: Int,
}

// Wait time is the time milliseconds the owner has to wait before being able to finalize
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
      WITHDRAW -> {
        expect Some(spent_utxo) = find_input(inputs, utxo)
        // Verifiy if the spent_utxo isn't spend and goes back to the contract
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
                // Expecting the lock time before the current tx time
                expect InlineDatum(inline_datum) = o.datum
                expect WithdrawDatum { lock_time } = inline_datum
                expect valid_after(validity_range, lock_time)
              },
            )
        and {
          // Ensure the output back to the contract is equal to the input
          output_back_to_contract == assets.lovelace_of(spent_utxo.output.value),
          // Ensure the owner signed the transaction
          key_signed(extra_signatories, owner),
        }
      }

      // }
      FINALIZE -> {
        // Ensure the owner signed the transaction
        expect Some(withdraw_datum) = datum
        and {
          key_signed(extra_signatories, owner),
          valid_after(self.validity_range, waitTime + withdraw_datum.lock_time),
        }
      }

      CANCEL -> {
        expect Some(spent_utxo) = find_input(inputs, utxo)

        // Verifiy if the spent_utxo isn't spend and goes back to the contract
        let output_back_to_contract =
          outputs
            |> list.filter(fn(out) { out.address == spent_utxo.output.address })
            |> list.map(fn(o) { assets.lovelace_of(o.value) })
            |> list.foldr(0, fn(n, total) { n + total })
        // expecting no datum to be present to reset it
        and {
          // Ensure the output back to the contract is equal to the input
          output_back_to_contract == assets.lovelace_of(spent_utxo.output.value),
          // Ensure the owner signed the transaction
          key_signed(extra_signatories, owner),
        }
      }
    }
  }

  else(_) {
    fail
  }
}
