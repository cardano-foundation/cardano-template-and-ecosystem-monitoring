#!/usr/bin/env node
/**
 * Storage CLI - Verifiable Audit Snapshots
 *
 * Command-line interface for generating, publishing, and verifying
 * audit snapshot commitments on the Cardano blockchain.
 */

import "dotenv/config";
import { Command } from "commander";
import { snapshotCommand } from "./cli/snapshot.js";
import { publishCommand } from "./cli/publish.js";
import { verifyCommand } from "./cli/verify.js";
import { merkleCommand } from "./cli/merkle.js";

const program = new Command();

program
  .name("storage-cli")
  .description("Storage: Verifiable Audit Snapshots on Cardano")
  .version("0.1.0");

// Register commands
program.addCommand(snapshotCommand);
program.addCommand(publishCommand);
program.addCommand(verifyCommand);
program.addCommand(merkleCommand);

// Parse and execute
program.parse();
