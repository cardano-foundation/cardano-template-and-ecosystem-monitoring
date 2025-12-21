/**
 * Blockchain adapter types
 *
 * Defines the interface for blockchain operations,
 * allowing easy swapping of underlying SDK implementations.
 */

import type { SnapshotType, OnChainCommitment } from "../types/index.js";

/**
 * Network configuration
 */
export type NetworkId = "preview" | "preprod" | "mainnet";

/**
 * UTxO reference (txHash#index)
 */
export interface UtxoRef {
  txHash: string;
  index: number;
}

/**
 * Parameters for publishing a commitment
 */
export interface PublishParams {
  snapshotId: string;
  snapshotType: SnapshotType;
  commitmentHash: string;
  seedUtxo?: UtxoRef; // Optional - will use first available UTxO if not provided
}

/**
 * Result of publishing a commitment
 */
export interface PublishResult {
  txId: string;
  utxoRef: UtxoRef;
  policyId: string;
  assetName: string;
}

/**
 * Query parameters for looking up a commitment
 */
export interface QueryParams {
  snapshotId?: string;
  utxoRef?: UtxoRef;
  policyId?: string;
  assetName?: string;
}

/**
 * Wallet configuration
 */
export interface WalletConfig {
  type: "seed" | "private-key";
  value: string;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  type: "blockfrost" | "koios" | "ogmios";
  url?: string;
  projectId?: string;
}

/**
 * Full adapter configuration
 */
export interface AdapterConfig {
  network: NetworkId;
  wallet: WalletConfig;
  provider: ProviderConfig;
}

/**
 * Blockchain adapter interface
 *
 * Abstracts blockchain operations for publishing and querying commitments.
 */
export interface BlockchainAdapter {
  /**
   * Get the network this adapter is connected to
   */
  getNetwork(): NetworkId;

  /**
   * Get the wallet address
   */
  getAddress(): Promise<string>;

  /**
   * Get available UTxOs in the wallet
   */
  getUtxos(): Promise<UtxoRef[]>;

  /**
   * Publish a snapshot commitment on-chain
   */
  publishCommitment(params: PublishParams): Promise<PublishResult>;

  /**
   * Query for an existing commitment
   */
  getCommitment(params: QueryParams): Promise<OnChainCommitment | null>;

  /**
   * Get the storage validator address
   */
  getValidatorAddress(): string;

  /**
   * Build the minting policy ID for a specific seed UTxO
   */
  getPolicyId(seedUtxo: UtxoRef): string;
}
