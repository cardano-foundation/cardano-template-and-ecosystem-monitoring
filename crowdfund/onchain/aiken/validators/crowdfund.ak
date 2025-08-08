use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/assets
use cardano/transaction.{
  InlineDatum, Input, Output, OutputReference, Transaction, find_input,
}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_validity_range.{valid_after}
use utils.{get_output_by_address}

pub type Action {
  DONATE
  WITHDRAW
  RECLAIM
}

pub type CrowdfundDatum {
  wallets: Pairs<VerificationKeyHash, Int>,
}

validator crowdfund(
  beneficiary: VerificationKeyHash,
  goal: Int,
  deadline: Int,
) {
  spend(
    datum_opt: Option<CrowdfundDatum>,
    redeemer: Action,
    utxo: OutputReference,
    self: Transaction,
  ) {
    let Transaction { inputs, outputs, extra_signatories, validity_range, .. } =
      self
    when datum_opt is {
      Some(datum) -> {
        expect Some(spent_utxo) = find_input(inputs, utxo)
        when redeemer is {
          WITHDRAW -> and {
              // Check if the deadline is exceeded
              valid_after(validity_range, deadline),
              // Check if the goal is reached
              assets.lovelace_of(spent_utxo.output.value) >= goal,
              // Check if the beneficiary signed the transaction
              key_signed(extra_signatories, beneficiary),
            }
          RECLAIM -> {
            // Allowing to extract the total donated amount of multiple donators
            let donated_amount =
              dict.from_pairs(datum.wallets)
                |> dict.filter(fn(k, _v) { list.has(extra_signatories, k) })
                |> dict.values()
                |> list.reduce(0, fn(x, acc) { x + acc })
            let lovelace_in_script = assets.lovelace_of(spent_utxo.output.value)
            when donated_amount == lovelace_in_script is {
              // Withdrawing all of the funds, there will be no payback
              True -> and {
                  // Check if the deadline is exceeded
                  valid_after(validity_range, deadline),
                  // Check if the goal is reached
                  lovelace_in_script <= goal,
                }
              // Check if the beneficiary signed the transaction
              False -> {
                let script_output_opt =
                  get_output_by_address(outputs, spent_utxo.output.address)
                expect Some(script_output) = script_output_opt
                expect InlineDatum(current_datum_data) = script_output.datum
                expect Some(CrowdfundDatum { wallets }) = current_datum_data
                let donors_removed =
                  list.any(
                    extra_signatories,
                    fn(signatory) {
                      dict.has_key(dict.from_pairs(wallets), signatory)
                    },
                  )
                and {
                  donors_removed == False,
                  lovelace_in_script <= assets.lovelace_of(script_output.value) + donated_amount,
                  // Check if the deadline is exceeded
                  valid_after(validity_range, deadline),
                  // Check if the goal is reached
                  assets.lovelace_of(spent_utxo.output.value) < goal,
                }
              }
            }
          }
          DONATE -> {
            let script_output_opt =
              get_output_by_address(outputs, spent_utxo.output.address)
            expect Some(script_output) = script_output_opt
            expect InlineDatum(current_datum_data) = script_output.datum
            expect CrowdfundDatum { wallets } = current_datum_data
            // Checking the overall donated amount
            let donated_amount =
              dict.from_pairs(wallets)
                |> dict.values()
                |> list.reduce(0, fn(x, acc) { x + acc })
            and {
              // There is now more funds in the script UTxO than before
              assets.lovelace_of(spent_utxo.output.value) < assets.lovelace_of(
                script_output.value,
              ),
              // The map of wallets is updated with the new donation
              donated_amount == assets.lovelace_of(script_output.value),
            }
          }
        }
      }
      // Unlocking a UTxO without a datum is allowed to avoid locking indefinitely
      None -> True
    }
  }

  else(_) {
    fail
  }
}
