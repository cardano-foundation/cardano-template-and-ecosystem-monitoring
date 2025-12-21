/**
 * Snapshot command - Generate audit snapshots
 *
 * Commands:
 * - snapshot:daily - Generate a daily snapshot
 * - snapshot:monthly - Generate a monthly snapshot
 */

import { Command } from "commander";
import { generateDailySnapshot, generateMonthlySnapshot } from "../core/generator.js";
import { hashSnapshot, canonicalize } from "../core/hash.js";

export const snapshotCommand = new Command("snapshot")
  .description("Generate audit snapshots");

/**
 * snapshot:daily command
 */
snapshotCommand
  .command("daily")
  .description("Generate a daily snapshot for a specific date")
  .requiredOption("-d, --date <date>", "Date in YYYY-MM-DD format")
  .requiredOption("-s, --seed <seed>", "Seed number for deterministic generation")
  .option("-o, --output <format>", "Output format: summary (default), json, hash", "summary")
  .option("--save <file>", "Save full snapshot to file")
.action(async (options: { date: string; seed: string; output: string; save?: string }) => {
    const { date, seed, output, save } = options;
    const seedNum = parseInt(seed, 10);

    if (isNaN(seedNum)) {
      console.error("Error: seed must be a number");
      process.exit(1);
    }

    try {
      console.log(`Generating daily snapshot for ${date} with seed ${seedNum}...`);
      const snapshot = generateDailySnapshot(date, seedNum);
      const hash = hashSnapshot(snapshot);

      switch (output) {
        case "json":
          console.log(JSON.stringify(snapshot, null, 2));
          break;
        case "hash":
          console.log(hash.commitmentHash);
          break;
        case "summary":
        default:
          console.log("\n=== Daily Snapshot ===");
          console.log(`Snapshot ID:     ${snapshot.snapshotId}`);
          console.log(`Type:            ${snapshot.snapshotType}`);
          console.log(`Seed:            ${snapshot.seed}`);
          console.log(`Records:         ${hash.recordCount}`);
          console.log(`Canonical Size:  ${hash.canonicalJsonLength} bytes`);
          console.log(`Commitment Hash: ${hash.commitmentHash}`);
          break;
      }

      if (save) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(save, JSON.stringify(snapshot, null, 2));
        console.log(`\nSnapshot saved to: ${save}`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

/**
 * snapshot:monthly command
 */
snapshotCommand
  .command("monthly")
  .description("Generate a monthly snapshot (aggregation of daily snapshots)")
  .requiredOption("-m, --month <month>", "Month in YYYY-MM format")
  .requiredOption("-s, --seed <seed>", "Seed number for deterministic generation")
  .option("-o, --output <format>", "Output format: summary (default), json, hash", "summary")
  .option("--save <file>", "Save full snapshot to file")
.action(async (options: { month: string; seed: string; output: string; save?: string }) => {
    const { month, seed, output, save } = options;
    const seedNum = parseInt(seed, 10);

    if (isNaN(seedNum)) {
      console.error("Error: seed must be a number");
      process.exit(1);
    }

    try {
      console.log(`Generating monthly snapshot for ${month} with seed ${seedNum}...`);
      const snapshot = generateMonthlySnapshot(month, seedNum);
      const hash = hashSnapshot(snapshot);

      switch (output) {
        case "json":
          console.log(JSON.stringify(snapshot, null, 2));
          break;
        case "hash":
          console.log(hash.commitmentHash);
          break;
        case "summary":
        default:
          console.log("\n=== Monthly Snapshot ===");
          console.log(`Snapshot ID:     ${snapshot.snapshotId}`);
          console.log(`Type:            ${snapshot.snapshotType}`);
          console.log(`Seed:            ${snapshot.seed}`);
          console.log(`Records:         ${hash.recordCount}`);
          console.log(`Canonical Size:  ${hash.canonicalJsonLength} bytes`);
          console.log(`Commitment Hash: ${hash.commitmentHash}`);
          break;
      }

      if (save) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(save, JSON.stringify(snapshot, null, 2));
        console.log(`\nSnapshot saved to: ${save}`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });
