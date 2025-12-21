/**
 * Merkle Tree Implementation for Audit Records
 *
 * Enables:
 * - Publishing only 1 hash (root) on the blockchain
 * - Proving any individual transaction afterwards
 * - Identifying WHICH transaction was altered
 */

import { createHash } from "node:crypto";
import type { SnapshotRecord } from "../types/index.js";

/**
 * Computes SHA-256 hash of a string
 */
function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Combines two hashes into one (parent node)
 */
function combineHashes(left: string, right: string): string {
  // Sort to ensure consistency
  const combined = left < right ? left + right : right + left;
  return sha256(combined);
}

/**
 * A node in the Merkle Tree
 */
export interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  data?: SnapshotRecord; // Only on leaves
  index?: number; // Leaf index
}

/**
 * Inclusion proof for a transaction
 */
export interface MerkleProof {
  /** Transaction index in the original list */
  index: number;
  /** Transaction hash (leaf) */
  leafHash: string;
  /** Transaction data */
  record: SnapshotRecord;
  /** Path of hashes to the root (siblings) */
  siblings: Array<{
    hash: string;
    position: "left" | "right"; // Sibling position
  }>;
  /** Root hash (published on blockchain) */
  rootHash: string;
}

/**
 * Result of building the Merkle Tree
 */
export interface MerkleTree {
  /** Root hash (goes to blockchain) */
  root: string;
  /** All nodes (for debug/visualization) */
  tree: MerkleNode;
  /** Leaf hashes (each transaction) */
  leaves: string[];
  /** Number of transactions */
  recordCount: number;
}

/**
 * Verification result
 */
export interface MerkleVerifyResult {
  valid: boolean;
  message: string;
  computedRoot?: string;
  expectedRoot?: string;
}

/**
 * Result of comparing two trees
 */
export interface MerkleDiffResult {
  identical: boolean;
  /** Indices of transactions that differ */
  differentIndices: number[];
  /** Altered transactions with details */
  differences: Array<{
    index: number;
    originalHash: string;
    currentHash: string;
    originalRecord?: SnapshotRecord;
    currentRecord?: SnapshotRecord;
  }>;
}

/**
 * Canonicalizes a record for consistent hashing
 */
function canonicalizeRecord(record: SnapshotRecord): string {
  const sorted = Object.keys(record)
    .sort()
    .reduce((obj: any, key) => {
      obj[key] = (record as any)[key];
      return obj;
    }, {});
  return JSON.stringify(sorted);
}

/**
 * Builds a Merkle Tree from records
 */
export function buildMerkleTree(records: SnapshotRecord[]): MerkleTree {
  if (records.length === 0) {
    throw new Error("Cannot build Merkle tree with no records");
  }

  // 1. Create leaves (hash of each transaction)
  const leaves: MerkleNode[] = records.map((record, index) => ({
    hash: sha256(canonicalizeRecord(record)),
    data: record,
    index,
  }));

  const leafHashes = leaves.map((l) => l.hash);

  // 2. If odd number, duplicate last
  if (leaves.length % 2 !== 0) {
    leaves.push({ ...leaves[leaves.length - 1] });
  }

  // 3. Build tree from bottom to top
  let currentLevel = leaves;

  while (currentLevel.length > 1) {
    const nextLevel: MerkleNode[] = [];

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || left; // Duplicate if odd

      const parent: MerkleNode = {
        hash: combineHashes(left.hash, right.hash),
        left,
        right,
      };

      nextLevel.push(parent);
    }

    currentLevel = nextLevel;
  }

  return {
    root: currentLevel[0].hash,
    tree: currentLevel[0],
    leaves: leafHashes,
    recordCount: records.length,
  };
}

/**
 * Generates inclusion proof for a specific transaction
 */
export function generateProof(
  records: SnapshotRecord[],
  index: number
): MerkleProof {
  if (index < 0 || index >= records.length) {
    throw new Error(`Invalid index: ${index}. Must be 0-${records.length - 1}`);
  }

  const record = records[index];
  const leafHash = sha256(canonicalizeRecord(record));

  // Create all leaves
  let leaves = records.map((r) => sha256(canonicalizeRecord(r)));

  // Duplicate if odd
  if (leaves.length % 2 !== 0) {
    leaves.push(leaves[leaves.length - 1]);
  }

  const siblings: MerkleProof["siblings"] = [];
  let currentIndex = index;
  let currentLevel = leaves;

  // Walk up the tree collecting siblings
  while (currentLevel.length > 1) {
    const isLeftNode = currentIndex % 2 === 0;
    const siblingIndex = isLeftNode ? currentIndex + 1 : currentIndex - 1;

    // Ensure siblingIndex is valid
    const siblingHash = currentLevel[siblingIndex] || currentLevel[currentIndex];

    siblings.push({
      hash: siblingHash,
      position: isLeftNode ? "right" : "left",
    });

    // Calculate next level
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || left;
      nextLevel.push(combineHashes(left, right));
    }

    currentIndex = Math.floor(currentIndex / 2);
    currentLevel = nextLevel;
  }

  return {
    index,
    leafHash,
    record,
    siblings,
    rootHash: currentLevel[0],
  };
}

/**
 * Verifies an inclusion proof
 */
export function verifyProof(proof: MerkleProof, expectedRoot?: string): MerkleVerifyResult {
  let currentHash = proof.leafHash;

  // Recalculate walking up the tree
  for (const sibling of proof.siblings) {
    if (sibling.position === "left") {
      currentHash = combineHashes(sibling.hash, currentHash);
    } else {
      currentHash = combineHashes(currentHash, sibling.hash);
    }
  }

  const rootToCheck = expectedRoot || proof.rootHash;
  const valid = currentHash === rootToCheck;

  return {
    valid,
    message: valid
      ? "Valid proof: transaction is included in the tree"
      : "Invalid proof: transaction does NOT match the root",
    computedRoot: currentHash,
    expectedRoot: rootToCheck,
  };
}

/**
 * Compares two lists of records and identifies differences
 */
export function findDifferences(
  original: SnapshotRecord[],
  current: SnapshotRecord[]
): MerkleDiffResult {
  const differences: MerkleDiffResult["differences"] = [];
  const differentIndices: number[] = [];

  const maxLen = Math.max(original.length, current.length);

  for (let i = 0; i < maxLen; i++) {
    const origRecord = original[i];
    const currRecord = current[i];

    const origHash = origRecord ? sha256(canonicalizeRecord(origRecord)) : "";
    const currHash = currRecord ? sha256(canonicalizeRecord(currRecord)) : "";

    if (origHash !== currHash) {
      differentIndices.push(i);
      differences.push({
        index: i,
        originalHash: origHash,
        currentHash: currHash,
        originalRecord: origRecord,
        currentRecord: currRecord,
      });
    }
  }

  return {
    identical: differences.length === 0,
    differentIndices,
    differences,
  };
}

/**
 * Generates hash of a single transaction (leaf)
 */
export function hashRecord(record: SnapshotRecord): string {
  return sha256(canonicalizeRecord(record));
}

/**
 * Formats the tree for visualization
 */
export function visualizeTree(tree: MerkleTree): string {
  const lines: string[] = [];

  lines.push("Merkle Tree");
  lines.push("═".repeat(70));
  lines.push(`Root: ${tree.root}`);
  lines.push(`Transactions: ${tree.recordCount}`);
  lines.push("─".repeat(70));
  lines.push("Leaves (transaction hashes):");

  tree.leaves.forEach((hash, i) => {
    lines.push(`  [${i}] ${hash.slice(0, 16)}...`);
  });

  return lines.join("\n");
}
