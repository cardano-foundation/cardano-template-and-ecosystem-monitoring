use aiken/collection/list
use aiken/crypto.{ScriptHash, blake2b_256}
use aiken/primitive/bytearray.{concat}
use cardano/assets.{PolicyId, quantity_of}
use cardano/transaction.{
  InlineDatum, OutputReference, Transaction, find_input, find_script_outputs,
}
use cocktail/vodka_mints.{token_minted}

/// Anonymous data commitment validator.
///
/// This validator implements a commit–reveal ownership pattern:
/// - During mint (commit), an identifier is recorded on-chain without
///   revealing the owner's public key.
/// - During spend (reveal), ownership is proven by providing a nonce
///   and a valid transaction signature.
///
/// The validator is parameterized by the script hash to which the
/// commitment output must be locked.
validator anonymousdata(script_hash: ScriptHash) {
  /// Mint phase (commit).
  ///
  /// Validates that:
  /// - exactly one marker token is minted,
  /// - the token is deposited at the expected script address,
  /// - the inline datum of the script output matches the committed identifier.
  ///
  /// No ownership or signature checks are performed in this phase.
  mint(id: ByteArray, policy_id: PolicyId, tx: Transaction) {
    let Transaction { mint, outputs, .. } = tx

    // locate the script output locked by this validator
    expect [script_out] = find_script_outputs(outputs, script_hash)

    // ensure exactly one marker token is minted
    let is_token_minted = token_minted(mint, policy_id, script_hash, 1)

    // ensure the marker token is deposited at the script output
    let marker_token_deposited =
      (
        script_out.value
          |> quantity_of(policy_id, script_hash)
      ) == 1

    // extract and validate the committed identifier from the inline datum
    expect InlineDatum(raw_script_datum) = script_out.datum
    expect script_out_datum: ByteArray = raw_script_datum

    let data_stored = id == script_out_datum

    is_token_minted && marker_token_deposited && data_stored
  }

  /// Spend phase (reveal).
  ///
  /// Validates that:
  /// - the transaction spends a UTxO locked by this validator,
  /// - the inline datum contains the committed identifier,
  /// - at least one transaction signatory can reproduce the identifier
  ///   by hashing (pkh || nonce).
  ///
  /// This phase reveals ownership and authorizes the spend.
  spend(
    _datum_opt: Option<Data>,
    nonce: ByteArray,
    oref: OutputReference,
    tx: Transaction,
  ) {
    let Transaction { inputs, extra_signatories, .. } = tx

    // ensure the referenced UTxO is being spent by this transaction
    expect Some(own_input) = find_input(inputs, oref)

    // extract the committed identifier from the inline datum
    expect InlineDatum(datum) = own_input.output.datum

    expect committed_id: ByteArray = datum

    // ownership proof: at least one signatory must satisfy
    // blake2b_256(pkh || nonce) == committed_id
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
