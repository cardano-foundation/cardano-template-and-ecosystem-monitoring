/**
 * Canonicalization and Hashing utilities
 *
 * Provides deterministic JSON serialization and SHA-256 hashing
 * for creating reproducible commitment hashes.
 */

import { createHash } from "node:crypto";
import type { Snapshot, SnapshotHash } from "../types/index.js";

/**
 * Canonicalize a value to a deterministic JSON string
 *
 * Rules:
 * - Object keys are sorted lexicographically (recursive)
 * - Arrays maintain their order (generator ensures determinism)
 * - No extra whitespace (compact JSON)
 * - Numbers are normalized (no trailing zeros issues with integers)
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, sortedReplacer);
}

/**
 * JSON.stringify replacer that sorts object keys
 */
function sortedReplacer(_key: string, value: unknown): unknown {
  // Handle null
  if (value === null) {
    return null;
  }

  // Handle arrays - keep as is (order is significant)
  if (Array.isArray(value)) {
    return value;
  }

  // Handle objects - sort keys
  if (typeof value === "object") {
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sortedObj[key] = (value as Record<string, unknown>)[key];
    }
    return sortedObj;
  }

  // Primitives pass through
  return value;
}

/**
 * Compute SHA-256 hash of data
 * @returns hex-encoded hash string (64 characters)
 */
export function computeHash(data: string | Buffer): string {
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest("hex");
}

/**
 * Compute SHA-256 hash as bytes
 * @returns Buffer containing 32 bytes
 */
export function computeHashBytes(data: string | Buffer): Buffer {
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest();
}

/**
 * Create a commitment hash for a snapshot
 *
 * Process:
 * 1. Extract only the records (not metadata like generatedAt)
 * 2. Canonicalize the records
 * 3. Hash the canonical JSON
 */
export function hashSnapshot(snapshot: Snapshot): SnapshotHash {
  // Create a hashable representation (only deterministic fields)
  const hashableData = {
    snapshotId: snapshot.snapshotId,
    snapshotType: snapshot.snapshotType,
    seed: snapshot.seed,
    records: snapshot.records,
  };

  const canonicalJson = canonicalize(hashableData);
  const commitmentHash = computeHash(canonicalJson);

  return {
    snapshotId: snapshot.snapshotId,
    snapshotType: snapshot.snapshotType,
    commitmentHash,
    recordCount: snapshot.records.length,
    canonicalJsonLength: canonicalJson.length,
  };
}

/**
 * Derive NFT asset name from snapshotId
 * Uses first 32 bytes of SHA-256 hash
 * @returns hex-encoded string (64 characters = 32 bytes)
 */
export function deriveAssetName(snapshotId: string): string {
  return computeHash(snapshotId);
}

/**
 * Derive NFT asset name as bytes
 * @returns Buffer containing 32 bytes
 */
export function deriveAssetNameBytes(snapshotId: string): Buffer {
  return computeHashBytes(snapshotId);
}
