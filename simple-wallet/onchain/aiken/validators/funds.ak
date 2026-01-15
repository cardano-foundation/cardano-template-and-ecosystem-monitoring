use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/assets.{flatten, lovelace_of}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_inputs.{inputs_with}
use cocktail/vodka_mints.{token_minted}
use intent.{PaymentIntent}

pub type Action {
  ExecuteTx
  Withdraw
}

validator funds(owner: VerificationKeyHash, wallet_script_hash: ScriptHash) {
  spend(
    _datum_opt: Option<Data>,
    redeemer: Action,
    _oref: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, outputs, mint, .. } = tx

    when redeemer is {
      ExecuteTx -> {
        expect [intent_refin] =
          inputs |> inputs_with(wallet_script_hash, "INTENT_MARKER")
        expect InlineDatum(intent_datum) = intent_refin.output.datum
        expect PaymentIntent { recipient, lovelace_amt, .. } = intent_datum
        let marker_opt =
          intent_refin.output.value
            |> flatten
            |> list.find(
                fn((_, asset_name, _)) { asset_name == "INTENT_MARKER" },
              )

        expect Some((wallet_script_hash, "INTENT_MARKER", _)) = marker_opt
        let amt_to_recipient =
          list.foldl(
            outputs,
            0,
            fn(output, acc) {
              if output.address == recipient {
                acc + lovelace_of(output.value)
              } else {
                acc
              }
            },
          )

        let payment_intent_burned =
          token_minted(mint, wallet_script_hash, "INTENT_MARKER", -1)

        amt_to_recipient == lovelace_amt && payment_intent_burned && key_signed(
          tx.extra_signatories,
          owner,
        )
      }

      Withdraw -> key_signed(tx.extra_signatories, owner)
    }
  }

  else(_) {
    fail
  }
}
