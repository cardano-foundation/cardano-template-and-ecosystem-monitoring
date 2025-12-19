/**
 * Merkle command - Merkle Tree operations for audit
 *
 * Commands:
 * - merkle tree - Build and display Merkle Tree
 * - merkle proof - Generate proof for a transaction
 * - merkle verify - Verify a proof
 * - merkle diff - Compare two snapshots and find differences
 */

import { Command } from "commander";
import { generateDailySnapshot, generateMonthlySnapshot } from "../core/generator.js";
import {
  buildMerkleTree,
  generateProof,
  verifyProof,
  findDifferences,
  hashRecord,
  type MerkleProof,
} from "../core/merkle.js";
import type { SnapshotRecord } from "../types/index.js";

export const merkleCommand = new Command("merkle")
  .description("Merkle Tree operations for audit verification");

/**
 * merkle tree - Build and display tree
 */
merkleCommand
  .command("tree")
  .description("Build Merkle Tree and show root hash")
  .requiredOption("-d, --date <date>", "Date in YYYY-MM-DD format")
  .requiredOption("-s, --seed <seed>", "Seed number for deterministic generation")
  .option("--show-leaves", "Show all leaf hashes")
  .option("--save <file>", "Save tree data to JSON file")
  .action(async (options: { date: string; seed: string; showLeaves?: boolean; save?: string }) => {
    const { date, seed, showLeaves, save } = options;
    const seedNum = parseInt(seed, 10);

    if (isNaN(seedNum)) {
      console.error("Error: seed must be a number");
      process.exit(1);
    }

    try {
      console.log(`Building Merkle Tree for ${date} with seed ${seedNum}...`);
      const snapshot = generateDailySnapshot(date, seedNum);
      const tree = buildMerkleTree(snapshot.records);

      console.log("\n=== Merkle Tree ===");
      console.log(`Snapshot ID:    ${snapshot.snapshotId}`);
      console.log(`Records:        ${tree.recordCount}`);
      console.log(`Tree Depth:     ${Math.ceil(Math.log2(tree.recordCount))} levels`);
      console.log(`\nMerkle Root:    ${tree.root}`);
      console.log("(Este é o hash que vai para a blockchain)");

      if (showLeaves) {
        console.log("\n=== Leaf Hashes (cada transação) ===");
        tree.leaves.forEach((hash, i) => {
          const record = snapshot.records[i];
          console.log(`[${i.toString().padStart(2, "0")}] ${hash.slice(0, 32)}... | ${record?.id || "padding"}`);
        });
      }

      if (save) {
        const fs = await import("node:fs/promises");
        const data = {
          snapshotId: snapshot.snapshotId,
          seed: seedNum,
          merkleRoot: tree.root,
          recordCount: tree.recordCount,
          leaves: tree.leaves,
          records: snapshot.records,
        };
        await fs.writeFile(save, JSON.stringify(data, null, 2));
        console.log(`\nTree data saved to: ${save}`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

/**
 * merkle proof - Generate inclusion proof for a transaction
 */
merkleCommand
  .command("proof")
  .description("Generate Merkle proof for a specific transaction")
  .requiredOption("-d, --date <date>", "Date in YYYY-MM-DD format")
  .requiredOption("-s, --seed <seed>", "Seed number")
  .requiredOption("-i, --index <index>", "Transaction index (0-based)")
  .option("--save <file>", "Save proof to JSON file")
  .action(async (options: { date: string; seed: string; index: string; save?: string }) => {
    const { date, seed, index: indexStr, save } = options;
    const seedNum = parseInt(seed, 10);
    const index = parseInt(indexStr, 10);

    if (isNaN(seedNum) || isNaN(index)) {
      console.error("Error: seed and index must be numbers");
      process.exit(1);
    }

    try {
      console.log(`Generating proof for transaction [${index}]...`);
      const snapshot = generateDailySnapshot(date, seedNum);

      if (index < 0 || index >= snapshot.records.length) {
        console.error(`Error: index must be 0-${snapshot.records.length - 1}`);
        process.exit(1);
      }

      const proof = generateProof(snapshot.records, index);

      console.log("\n=== Merkle Proof ===");
      console.log(`Transaction Index: ${proof.index}`);
      console.log(`Transaction ID:    ${proof.record.id}`);
      console.log(`Description:       ${proof.record.description}`);
      console.log(`Amount:            ${proof.record.amount}`);
      console.log(`Leaf Hash:         ${proof.leafHash}`);
      console.log(`Merkle Root:       ${proof.rootHash}`);
      console.log(`\nProof Path (${proof.siblings.length} siblings):`);
      proof.siblings.forEach((s, i) => {
        console.log(`  Level ${i + 1}: ${s.hash.slice(0, 40)}... (${s.position})`);
      });

      // Verify immediately
      const result = verifyProof(proof);
      console.log(`\nVerification: ${result.valid ? "✓ VALID" : "✗ INVALID"}`);

      if (save) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(save, JSON.stringify(proof, null, 2));
        console.log(`\nProof saved to: ${save}`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

/**
 * merkle verify - Verify a proof against a root
 */
merkleCommand
  .command("verify")
  .description("Verify a Merkle proof")
  .requiredOption("-p, --proof <file>", "Proof JSON file")
  .option("-r, --root <hash>", "Expected Merkle root (uses proof root if not provided)")
  .action(async (options: { proof: string; root?: string }) => {
    const { proof: proofFile, root } = options;

    try {
      const fs = await import("node:fs/promises");
      const proofData = JSON.parse(await fs.readFile(proofFile, "utf-8")) as MerkleProof;

      console.log("=== Verifying Merkle Proof ===");
      console.log(`Transaction: ${proofData.record.id}`);
      console.log(`Leaf Hash:   ${proofData.leafHash.slice(0, 40)}...`);

      const result = verifyProof(proofData, root);

      console.log(`\nComputed Root: ${result.computedRoot}`);
      console.log(`Expected Root: ${result.expectedRoot}`);
      console.log(`\nResult: ${result.valid ? "✓ PROOF VALID" : "✗ PROOF INVALID"}`);
      console.log(result.message);

      process.exit(result.valid ? 0 : 1);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

/**
 * merkle diff - Compare two sets of data and find differences
 */
merkleCommand
  .command("diff")
  .description("Compare original data with a CSV/JSON file and find altered transactions")
  .requiredOption("-d, --date <date>", "Original date in YYYY-MM-DD format")
  .requiredOption("-s, --seed <seed>", "Original seed number")
  .requiredOption("-f, --file <file>", "File to compare (JSON snapshot or CSV)")
  .action(async (options: { date: string; seed: string; file: string }) => {
    const { date, seed, file } = options;
    const seedNum = parseInt(seed, 10);

    if (isNaN(seedNum)) {
      console.error("Error: seed must be a number");
      process.exit(1);
    }

    try {
      // Generate original data
      console.log(`Loading original data (${date}, seed ${seedNum})...`);
      const original = generateDailySnapshot(date, seedNum);

      // Load comparison file
      console.log(`Loading comparison file: ${file}`);
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(file, "utf-8");

      let currentRecords: SnapshotRecord[];

      if (file.endsWith(".json")) {
        const data = JSON.parse(content);
        currentRecords = data.records || data;
      } else if (file.endsWith(".csv")) {
        // Parse CSV
        currentRecords = parseCSV(content);
      } else {
        console.error("Error: file must be .json or .csv");
        process.exit(1);
      }

      // Compare
      console.log("\n=== Comparing Data ===");
      console.log(`Original records: ${original.records.length}`);
      console.log(`Current records:  ${currentRecords.length}`);

      const diff = findDifferences(original.records, currentRecords);

      if (diff.identical) {
        console.log("\n✓ Data is IDENTICAL - no differences found");
        process.exit(0);
      }

      console.log(`\n✗ DIFFERENCES FOUND: ${diff.differences.length} transaction(s) altered`);
      console.log("\n=== Altered Transactions ===");

      for (const d of diff.differences) {
        console.log(`\n[${d.index}] Transaction MODIFIED`);
        console.log(`  ID: ${d.originalRecord?.id || d.currentRecord?.id || "unknown"}`);
        console.log(`  Original Hash: ${d.originalHash.slice(0, 40)}...`);
        console.log(`  Current Hash:  ${d.currentHash.slice(0, 40)}...`);

        // Show field differences
        if (d.originalRecord && d.currentRecord) {
          console.log("  Changes:");
          for (const key of Object.keys(d.originalRecord)) {
            const orig = (d.originalRecord as any)[key];
            const curr = (d.currentRecord as any)[key];
            if (JSON.stringify(orig) !== JSON.stringify(curr)) {
              console.log(`    ${key}: ${orig} → ${curr}`);
            }
          }
        } else if (!d.originalRecord) {
          console.log("  Status: ADDED (not in original)");
        } else if (!d.currentRecord) {
          console.log("  Status: REMOVED (missing from current)");
        }
      }

      process.exit(1);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

/**
 * Parse CSV to records
 */
function parseCSV(content: string): SnapshotRecord[] {
  const lines = content.trim().split("\n");

  const parseLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0]).map((h) => h.toLowerCase().replace(/"/g, ""));

  return lines.slice(1).map((line) => {
    const values = parseLine(line);
    const record: any = {};

    headers.forEach((header, i) => {
      const value = values[i]?.replace(/"/g, "") ?? "";
      if (header === "amount") {
        record[header] = parseFloat(value) || 0;
      } else {
        record[header] = value;
      }
    });

    return record as SnapshotRecord;
  });
}
