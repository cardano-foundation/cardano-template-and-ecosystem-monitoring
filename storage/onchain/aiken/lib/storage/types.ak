/// Types for Storage: Verifiable Audit Snapshots
///
/// These types define the on-chain data structures for storing
/// cryptographic commitments of audit snapshots.

/// Snapshot type enum
/// - Daily: Single day snapshot (YYYY-MM-DD)
/// - Monthly: Aggregated monthly snapshot (YYYY-MM)
pub type SnapshotType {
  Daily
  Monthly
}

/// Registry datum stored with each snapshot commitment
///
/// Fields:
/// - snapshot_id: The identifier (e.g., "2025-12-19" or "2025-12")
/// - snapshot_type: Daily or Monthly
/// - commitment_hash: SHA-256 hash of the canonical snapshot data (32 bytes)
/// - published_at: POSIX timestamp when published
pub type RegistryDatum {
  snapshot_id: ByteArray,
  snapshot_type: SnapshotType,
  commitment_hash: ByteArray,
  published_at: Int,
}

/// Redeemer for the minting policy
/// Contains the snapshot information needed for validation
pub type MintRedeemer {
  snapshot_id: ByteArray,
  snapshot_type: SnapshotType,
  commitment_hash: ByteArray,
}

/// Convert SnapshotType to Int for comparison
pub fn snapshot_type_to_int(st: SnapshotType) -> Int {
  when st is {
    Daily -> 0
    Monthly -> 1
  }
}

/// Check if two SnapshotTypes are equal
pub fn snapshot_type_eq(a: SnapshotType, b: SnapshotType) -> Bool {
  snapshot_type_to_int(a) == snapshot_type_to_int(b)
}
