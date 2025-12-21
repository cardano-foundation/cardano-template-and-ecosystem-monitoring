/**
 * Publish command - Publish snapshot commitments on-chain
 *
 * Commands:
 * - publish:daily - Publish a daily snapshot commitment
 * - publish:monthly - Publish a monthly snapshot commitment
 */

import { Command } from "commander";
import { generateDailySnapshot, generateMonthlySnapshot } from "../core/generator.js";
import { hashSnapshot, deriveAssetName } from "../core/hash.js";
import { createBlazeAdapter, configFromEnv } from "../blockchain/blaze-adapter.js";
import type { NetworkId } from "../blockchain/types.js";

export const publishCommand = new Command("publish")
  .description("Publish snapshot commitments on-chain");

/**
 * publish:daily command
 */
publishCommand
  .command("daily")
  .description("Publish a daily snapshot commitment to the blockchain")
  .requiredOption("-d, --date <date>", "Date in YYYY-MM-DD format")
  .requiredOption("-s, --seed <seed>", "Seed number for deterministic generation")
  .option("-n, --network <network>", "Network: preview, preprod, mainnet", "preview")
  .option("--dry-run", "Generate and show what would be published without submitting")
.action(async (options: { date: string; seed: string; network: string; dryRun?: boolean }) => {
    const { date, seed, network, dryRun } = options;
    const seedNum = parseInt(seed, 10);

    if (isNaN(seedNum)) {
      console.error("Error: seed must be a number");
      process.exit(1);
    }

    try {
      console.log(`Generating daily snapshot for ${date} with seed ${seedNum}...`);
      const snapshot = generateDailySnapshot(date, seedNum);
      const hash = hashSnapshot(snapshot);
      const assetName = deriveAssetName(snapshot.snapshotId);

      console.log("\n=== Commitment Details ===");
      console.log(`Snapshot ID:     ${snapshot.snapshotId}`);
      console.log(`Type:            ${snapshot.snapshotType}`);
      console.log(`Records:         ${hash.recordCount}`);
      console.log(`Commitment Hash: ${hash.commitmentHash}`);
      console.log(`Asset Name:      ${assetName}`);
      console.log(`Network:         ${network}`);

      if (dryRun) {
        console.log("\n[DRY RUN] Transaction not submitted.");
        return;
      }

      console.log("\nPublishing to blockchain...");

      // Create adapter from environment
      const config = {
        ...configFromEnv(),
        network: network as NetworkId,
      };

      const adapter = await createBlazeAdapter(config);

      const result = await adapter.publishCommitment({
        snapshotId: snapshot.snapshotId,
        snapshotType: snapshot.snapshotType,
        commitmentHash: hash.commitmentHash,
      });

      console.log("\n=== Published Successfully ===");
      console.log(`Transaction ID: ${result.txId}`);
      console.log(`UTxO Reference: ${result.utxoRef.txHash}#${result.utxoRef.index}`);
      console.log(`Policy ID:      ${result.policyId}`);
      console.log(`Asset Name:     ${result.assetName}`);

    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

/**
 * publish:monthly command
 */
publishCommand
  .command("monthly")
  .description("Publish a monthly snapshot commitment to the blockchain")
  .requiredOption("-m, --month <month>", "Month in YYYY-MM format")
  .requiredOption("-s, --seed <seed>", "Seed number for deterministic generation")
  .option("-n, --network <network>", "Network: preview, preprod, mainnet", "preview")
  .option("--dry-run", "Generate and show what would be published without submitting")
.action(async (options: { month: string; seed: string; network: string; dryRun?: boolean }) => {
    const { month, seed, network, dryRun } = options;
    const seedNum = parseInt(seed, 10);

    if (isNaN(seedNum)) {
      console.error("Error: seed must be a number");
      process.exit(1);
    }

    try {
      console.log(`Generating monthly snapshot for ${month} with seed ${seedNum}...`);
      const snapshot = generateMonthlySnapshot(month, seedNum);
      const hash = hashSnapshot(snapshot);
      const assetName = deriveAssetName(snapshot.snapshotId);

      console.log("\n=== Commitment Details ===");
      console.log(`Snapshot ID:     ${snapshot.snapshotId}`);
      console.log(`Type:            ${snapshot.snapshotType}`);
      console.log(`Records:         ${hash.recordCount}`);
      console.log(`Commitment Hash: ${hash.commitmentHash}`);
      console.log(`Asset Name:      ${assetName}`);
      console.log(`Network:         ${network}`);

      if (dryRun) {
        console.log("\n[DRY RUN] Transaction not submitted.");
        return;
      }

      console.log("\nPublishing to blockchain...");

      // Create adapter from environment
      const config = {
        ...configFromEnv(),
        network: network as NetworkId,
      };

      const adapter = await createBlazeAdapter(config);

      const result = await adapter.publishCommitment({
        snapshotId: snapshot.snapshotId,
        snapshotType: snapshot.snapshotType,
        commitmentHash: hash.commitmentHash,
      });

      console.log("\n=== Published Successfully ===");
      console.log(`Transaction ID: ${result.txId}`);
      console.log(`UTxO Reference: ${result.utxoRef.txHash}#${result.utxoRef.index}`);
      console.log(`Policy ID:      ${result.policyId}`);
      console.log(`Asset Name:     ${result.assetName}`);

    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });
