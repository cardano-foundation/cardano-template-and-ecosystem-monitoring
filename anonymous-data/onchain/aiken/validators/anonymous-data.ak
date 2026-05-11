use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray.{concat}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{Output, OutputReference, Transaction, find_input, InlineDatum}
use cocktail/vodka_mints.{token_minted}
use cocktail/vodka_value.{value_tokens}

// Commit-reveal of an off-chain identifier without binding it to a pkh on-chain.
// Commit: mint a token whose asset name = blake2b_256(pkh || nonce).
// Reveal: spend that token and prove a signer can reconstruct the same hash.
// The datum is opaque payload — only its presence is checked.
validator anonymous_data {
  // Commit. No signature check here: anonymity comes from the fact that the
  // commitment hash hides which pkh produced it until reveal time. We only
  // bind the token to a datum so the payload travels with the marker.
  mint(id: ByteArray, policy_id: PolicyId, tx: Transaction) {
    let Transaction { mint, outputs, .. } = tx

    let id_token_minted = token_minted(mint, policy_id, id, 1)

    let data_stored =
      when
        list.find(
          outputs,
          fn(output) { quantity_of(output.value, policy_id, id) == 1 },
        )
      is {
        Some(out) -> {
          expect InlineDatum(_raw_datum) = out.datum
          True
        }
        None -> False
      }

    id_token_minted && data_stored
  }

  // Reveal. The committed id lives in the asset name of the only non-ADA
  // token in the spent UTxO — recovering it from value rather than the
  // redeemer prevents a spender from claiming a different commitment.
  // Ownership: any signer who can produce blake2b_256(pkh || nonce) == id.
  spend(
    _datum_opt: Option<Data>,
    nonce: ByteArray,
    oref: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, extra_signatories, .. } = tx

    expect Some(own_input) = find_input(inputs, oref)

    expect [(_policy_id, committed_id, 1)] =
      own_input.output.value |> value_tokens

    list.any(
      extra_signatories,
      fn(pkh) { blake2b_256(concat(pkh, nonce)) == committed_id },
    )
  }

  else(_) {
    fail
  }
}
