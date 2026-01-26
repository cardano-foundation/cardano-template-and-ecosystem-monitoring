/// Storage Validator for Audit Snapshot Commitments
///
/// This validator holds UTxOs containing snapshot commitment data.
/// The UTxOs are immutable - they can never be spent once created.
///
/// Each UTxO contains:
/// - An NFT marker (proving uniqueness)
/// - A datum with the snapshot metadata and commitment hash
///
/// The immutability ensures that once a commitment is published,
/// it cannot be altered or removed, providing a permanent audit trail.

use storage/types.{RegistryDatum}

/// Storage validator - always fails on spend
///
/// This makes the registry UTxOs immutable.
/// Once created (via the minting policy), they cannot be spent.
validator storage {
  spend(_datum: Option<RegistryDatum>, _redeemer: Data, _output_ref: Data, _tx: Data) {
    // Always fail - UTxOs locked here are immutable
    fail @"Storage UTxOs are immutable and cannot be spent"
  }

  else(_) {
    fail @"Invalid purpose for storage validator"
  }
}
