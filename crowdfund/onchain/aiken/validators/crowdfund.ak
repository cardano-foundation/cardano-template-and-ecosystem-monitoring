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

// All-or-nothing crowdfund. Donors accumulate into a single script UTxO; the
// datum is a per-donor ledger of contributions. After the deadline the
// beneficiary withdraws iff goal reached; otherwise each donor reclaims
// exactly their stake. Parameters fix the campaign at script-hash time.

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
          // WITHDRAW — beneficiary takes the pot after the deadline iff the
          // goal was met. No continuing UTxO; campaign ends.
          WITHDRAW -> and {
              valid_after(validity_range, deadline),
              assets.lovelace_of(spent_utxo.output.value) >= goal,
              key_signed(extra_signatories, beneficiary),
            }
          // RECLAIM — donors recover their stake after the deadline if the
          // goal failed. Supports batch reclaim by multiple signers in one tx.
          RECLAIM -> {
            // Sum only the contributions of signers in this tx — refusing to
            // pay anyone whose key didn't authorise the spend.
            let donated_amount =
              dict.from_pairs(datum.wallets)
                |> dict.filter(fn(k, _v) { list.has(extra_signatories, k) })
                |> dict.values()
                |> list.reduce(0, fn(x, acc) { x + acc })
            let lovelace_in_script = assets.lovelace_of(spent_utxo.output.value)
            when donated_amount == lovelace_in_script is {
              // Last reclaimers — draining the UTxO. No continuing output
              // required; goal must have failed.
              True -> and {
                  valid_after(validity_range, deadline),
                  lovelace_in_script <= goal,
                }
              // Partial reclaim — must rebuild a script UTxO with the
              // reclaiming donors removed from the ledger and the matching
              // lovelace subtracted.
              False -> {
                let script_output_opt =
                  get_output_by_address(outputs, spent_utxo.output.address)
                expect Some(script_output) = script_output_opt
                expect InlineDatum(current_datum_data) = script_output.datum
                expect Some(CrowdfundDatum { wallets }) = current_datum_data
                // Anti-replay: every signer must have been deleted from the
                // new wallet map — otherwise they could reclaim again later.
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
                  valid_after(validity_range, deadline),
                  assets.lovelace_of(spent_utxo.output.value) < goal,
                }
              }
            }
          }
          // DONATE — append to the ledger and grow the pot. No deadline check
          // here: late donations are harmless because withdrawal/reclaim
          // gates handle the outcome. Datum-sum must equal new balance,
          // preventing a donor from over-claiming credit.
          DONATE -> {
            let script_output_opt =
              get_output_by_address(outputs, spent_utxo.output.address)
            expect Some(script_output) = script_output_opt
            expect InlineDatum(current_datum_data) = script_output.datum
            expect CrowdfundDatum { wallets } = current_datum_data
            let donated_amount =
              dict.from_pairs(wallets)
                |> dict.values()
                |> list.reduce(0, fn(x, acc) { x + acc })
            and {
              assets.lovelace_of(spent_utxo.output.value) < assets.lovelace_of(
                script_output.value,
              ),
              donated_amount == assets.lovelace_of(script_output.value),
            }
          }
        }
      }
      // Datum-less UTxOs at this address are unlocked unconditionally —
      // otherwise dust sent here by mistake would be permanently lost.
      None -> True
    }
  }

  else(_) {
    fail
  }
}
