use aiken/collection/list
use aiken/crypto.{ScriptHash, VerificationKeyHash}
use cardano/assets.{flatten, lovelace_of}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}
use cocktail/vodka_extra_signatories.{key_signed}
use cocktail/vodka_inputs.{inputs_with}
use cocktail/vodka_mints.{token_minted}
use intent.{PaymentIntent}

// Funds vault paired with the intent/wallet scripts. Two paths: ExecuteTx
// pays out exactly what a pending PaymentIntent specifies (and burns the
// intent marker), Withdraw is an owner-only escape hatch. The wallet script
// hash is a parameter so funds are bound to one specific wallet.

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
      // ExecuteTx — consume one intent UTxO (identified by its INTENT_MARKER),
      // pay the recipient the intent amount, burn the marker so the intent
      // can't be replayed. Owner must still sign — co-authorisation, not
      // delegation; the intent describes WHAT to do, the owner authorises WHEN.
      ExecuteTx -> {
        expect [intent_refin] =
          inputs |> inputs_with(wallet_script_hash, "INTENT_MARKER")
        expect InlineDatum(intent_datum) = intent_refin.output.datum
        expect PaymentIntent { recipient, lovelace_amt, .. } = intent_datum
        // Re-bind wallet_script_hash from the pattern to confirm the marker
        // really came from the parameterised wallet, not some lookalike.
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

        // Exact equality, not >=: the wallet pays precisely the intent —
        // any surplus would be a tip the owner didn't authorise.
        amt_to_recipient == lovelace_amt && payment_intent_burned && key_signed(
          tx.extra_signatories,
          owner,
        )
      }

      // Withdraw — unconditional owner-only sweep. Useful for recovery or
      // closing the wallet without going through the intent flow.
      Withdraw -> key_signed(tx.extra_signatories, owner)
    }
  }

  else(_) {
    fail
  }
}
