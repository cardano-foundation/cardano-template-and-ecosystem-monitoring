/**
 * Types for audit snapshot records
 */

export type Direction = "debit" | "credit";

export type SnapshotType = "daily" | "monthly";

/**
 * A single record in an audit snapshot
 */
export interface SnapshotRecord {
  id: string;
  timestamp: string; // ISO 8601 format
  description: string;
  amount: number;
  direction: Direction;
  account: string;
  counterparty: string;
}

/**
 * A complete snapshot dataset
 */
export interface Snapshot {
  snapshotId: string; // YYYY-MM-DD for daily, YYYY-MM for monthly
  snapshotType: SnapshotType;
  seed: number;
  generatedAt: string; // ISO 8601 timestamp
  records: SnapshotRecord[];
}

/**
 * Result of hashing a snapshot
 */
export interface SnapshotHash {
  snapshotId: string;
  snapshotType: SnapshotType;
  commitmentHash: string; // hex encoded SHA-256
  recordCount: number;
  canonicalJsonLength: number;
}

/**
 * On-chain commitment data
 */
export interface OnChainCommitment {
  snapshotId: string;
  snapshotType: SnapshotType;
  commitmentHash: string;
  publishedAt: number; // POSIX timestamp
  txId: string;
  utxoRef: string;
}

/**
 * Verification result
 */
export type VerificationStatus = "MATCH" | "MISMATCH" | "NOT_FOUND";

export interface VerificationResult {
  status: VerificationStatus;
  snapshotId: string;
  snapshotType: SnapshotType;
  localHash: string;
  onChainHash?: string;
  txId?: string;
  message: string;
}
