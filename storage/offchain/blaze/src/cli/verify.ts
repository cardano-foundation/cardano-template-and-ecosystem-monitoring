/**
 * Verify command - Verify snapshot commitments against on-chain data
 *
 * Commands:
 * - verify:daily - Verify a daily snapshot
 * - verify:monthly - Verify a monthly snapshot
 */

import { Command } from "commander";
import { generateDailySnapshot, generateMonthlySnapshot } from "../core/generator.js";
import { hashSnapshot, deriveAssetName } from "../core/hash.js";
import { createBlazeAdapter, configFromEnv } from "../blockchain/blaze-adapter.js";
import type { NetworkId } from "../blockchain/types.js";
import type { VerificationResult, VerificationStatus } from "../types/index.js";

export const verifyCommand = new Command("verify")
  .description("Verify snapshot commitments against on-chain data");

/**
 * Format verification result for display
 */
function displayResult(result: VerificationResult): void {
  const statusColors: Record<VerificationStatus, string> = {
    MATCH: "\x1b[32m", // Green
    MISMATCH: "\x1b[31m", // Red
    NOT_FOUND: "\x1b[33m", // Yellow
  };
  const reset = "\x1b[0m";
  const color = statusColors[result.status];

  console.log(`\n=== Verification Result ===`);
  console.log(`Snapshot ID:  ${result.snapshotId}`);
  console.log(`Type:         ${result.snapshotType}`);
  console.log(`Status:       ${color}${result.status}${reset}`);
  console.log(`Local Hash:   ${result.localHash}`);

  if (result.onChainHash) {
    console.log(`On-chain Hash: ${result.onChainHash}`);
  }

  if (result.txId) {
    console.log(`Transaction:  ${result.txId}`);
  }

  console.log(`\nMessage: ${result.message}`);
}

/**
 * verify:daily command
 */
verifyCommand
  .command("daily")
  .description("Verify a daily snapshot commitment against on-chain data")
  .requiredOption("-d, --date <date>", "Date in YYYY-MM-DD format")
  .requiredOption("-s, --seed <seed>", "Seed number for deterministic generation")
  .option("-n, --network <network>", "Network: preview, preprod, mainnet", "preview")
  .option("--tx-id <txId>", "Transaction ID to verify against (optional)")
.action(async (options: { date: string; seed: string; network: string; txId?: string }) => {
    const { date, seed, network, txId } = options;
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

      console.log(`Local commitment hash: ${hash.commitmentHash}`);
      console.log(`Asset name: ${assetName}`);
      console.log(`\nQuerying ${network} network...`);

      // Create adapter from environment
      const config = {
        ...configFromEnv(),
        network: network as NetworkId,
      };

      const adapter = await createBlazeAdapter(config);

      const onChainCommitment = await adapter.getCommitment({
        snapshotId: snapshot.snapshotId,
      });

      let result: VerificationResult;

      if (!onChainCommitment) {
        result = {
          status: "NOT_FOUND",
          snapshotId: snapshot.snapshotId,
          snapshotType: snapshot.snapshotType,
          localHash: hash.commitmentHash,
          message: "No commitment found on-chain for this snapshot ID.",
        };
      } else if (onChainCommitment.commitmentHash === hash.commitmentHash) {
        result = {
          status: "MATCH",
          snapshotId: snapshot.snapshotId,
          snapshotType: snapshot.snapshotType,
          localHash: hash.commitmentHash,
          onChainHash: onChainCommitment.commitmentHash,
          txId: onChainCommitment.txId,
          message: "Local snapshot matches on-chain commitment. Data integrity verified!",
        };
      } else {
        result = {
          status: "MISMATCH",
          snapshotId: snapshot.snapshotId,
          snapshotType: snapshot.snapshotType,
          localHash: hash.commitmentHash,
          onChainHash: onChainCommitment.commitmentHash,
          txId: onChainCommitment.txId,
          message: "WARNING: Local snapshot does not match on-chain commitment!",
        };
      }

      displayResult(result);

      // Exit with appropriate code
      process.exit(result.status === "MATCH" ? 0 : 1);

    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

/**
 * verify:monthly command
 */
verifyCommand
  .command("monthly")
  .description("Verify a monthly snapshot commitment against on-chain data")
  .requiredOption("-m, --month <month>", "Month in YYYY-MM format")
  .requiredOption("-s, --seed <seed>", "Seed number for deterministic generation")
  .option("-n, --network <network>", "Network: preview, preprod, mainnet", "preview")
  .option("--tx-id <txId>", "Transaction ID to verify against (optional)")
.action(async (options: { month: string; seed: string; network: string; txId?: string }) => {
    const { month, seed, network, txId } = options;
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

      console.log(`Local commitment hash: ${hash.commitmentHash}`);
      console.log(`Asset name: ${assetName}`);
      console.log(`\nQuerying ${network} network...`);

      // Create adapter from environment
      const config = {
        ...configFromEnv(),
        network: network as NetworkId,
      };

      const adapter = await createBlazeAdapter(config);

      const onChainCommitment = await adapter.getCommitment({
        snapshotId: snapshot.snapshotId,
      });

      let result: VerificationResult;

      if (!onChainCommitment) {
        result = {
          status: "NOT_FOUND",
          snapshotId: snapshot.snapshotId,
          snapshotType: snapshot.snapshotType,
          localHash: hash.commitmentHash,
          message: "No commitment found on-chain for this snapshot ID.",
        };
      } else if (onChainCommitment.commitmentHash === hash.commitmentHash) {
        result = {
          status: "MATCH",
          snapshotId: snapshot.snapshotId,
          snapshotType: snapshot.snapshotType,
          localHash: hash.commitmentHash,
          onChainHash: onChainCommitment.commitmentHash,
          txId: onChainCommitment.txId,
          message: "Local snapshot matches on-chain commitment. Data integrity verified!",
        };
      } else {
        result = {
          status: "MISMATCH",
          snapshotId: snapshot.snapshotId,
          snapshotType: snapshot.snapshotType,
          localHash: hash.commitmentHash,
          onChainHash: onChainCommitment.commitmentHash,
          txId: onChainCommitment.txId,
          message: "WARNING: Local snapshot does not match on-chain commitment!",
        };
      }

      displayResult(result);

      // Exit with appropriate code
      process.exit(result.status === "MATCH" ? 0 : 1);

    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });
