use aiken/collection/list
use aiken/crypto.{blake2b_256}
use aiken/primitive/bytearray.{concat}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{Output, OutputReference, Transaction, find_input, InlineDatum}
use cocktail/vodka_mints.{token_minted}
use cocktail/vodka_value.{value_tokens}

/// Anonymous data commitment validator.
///
/// Model:
/// - ID = blake2b_256(pkh || nonce)
/// - ID is used as the *asset name* of a singleton token
/// - Arbitrary user data may be stored in the inline datum;
///   the datum contents are not interpreted, but the presence
///   of an inline datum is enforced on-chain
///
/// Commit (mint):
/// - Mints exactly one token with asset name = ID
/// - Ensures that this token appears in at least one transaction output
///   carrying an inline datum
/// - Does not perform ownership or signature checks
///
/// Reveal (spend):
/// - User reveals the nonce
/// - The committed ID is recovered from the asset name of the spent UTxO
/// - Ownership is proven if a transaction signer can recreate the ID
validator anonymous_data {
  /// Commit phase (mint).
  ///
  /// Validates that:
  /// - exactly one token with asset name = id is minted,
  /// - the minted token appears in at least one transaction output,
  /// - that output carries an inline datum.
  ///
  /// The datum contents are treated as opaque user data and
  /// are not interpreted or validated beyond existence.
  /// No ownership or signature checks occur in this phase.
  mint(id: ByteArray, policy_id: PolicyId, tx: Transaction) {
    let Transaction { mint, outputs, .. } = tx

    // ensure exactly one ID token is minted
    let id_token_minted = token_minted(mint, policy_id, id, 1)

    // ensure that the data is stored in datum with the minted token
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

  /// Reveal phase (spend).
  ///
  /// Validates that:
  /// - a UTxO referenced by the transaction is being spent,
  /// - the spent UTxO carries exactly one non-ADA token,
  ///   whose asset name is treated as the committed ID,
  /// - at least one transaction signer can reproduce the ID:
  ///
  ///     blake2b_256(pkh || nonce) == committed_id
  ///
  /// The inline datum is intentionally ignored and may contain
  /// arbitrary user-defined data.
  spend(
    _datum_opt: Option<Data>,
    nonce: ByteArray,
    oref: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, extra_signatories, .. } = tx

    // ensure referenced UTxO is being spent
    expect Some(own_input) = find_input(inputs, oref)

    // expect exactly one non-ADA token in the spent UTxO;
    // its asset name represents the committed identifier
    expect [(_policy_id, committed_id, 1)] =
      own_input.output.value |> value_tokens

    // ownership proof: signer must be able to reconstruct the committed ID
    list.any(
      extra_signatories,
      fn(pkh) { blake2b_256(concat(pkh, nonce)) == committed_id },
    )
  }

  /// Reject all other redeemer contexts.
  else(_) {
    fail
  }
}
