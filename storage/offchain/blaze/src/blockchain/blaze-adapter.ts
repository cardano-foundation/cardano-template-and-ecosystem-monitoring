/**
 * Blaze SDK Adapter Implementation
 *
 * Implements the BlockchainAdapter interface using the Blaze SDK
 * for Cardano blockchain operations.
 */

import {
  Blaze,
  Core,
  Blockfrost,
  HotWallet,
  type Provider,
} from "@blaze-cardano/sdk";
import {
  Bip32PrivateKey,
  mnemonicToEntropy,
  wordlist,
} from "@blaze-cardano/core";
import { applyParams } from "@blaze-cardano/uplc";
import type {
  BlockchainAdapter,
  AdapterConfig,
  NetworkId,
  UtxoRef,
  PublishParams,
  PublishResult,
  QueryParams,
} from "./types.js";
import type { OnChainCommitment, SnapshotType } from "../types/index.js";
import { deriveAssetName, deriveAssetNameBytes } from "../core/hash.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Get compiled contracts from plutus.json
interface PlutusJson {
  validators: Array<{
    title: string;
    compiledCode: string;
    hash: string;
  }>;
}

function loadPlutusJson(): PlutusJson | null {
  // Try multiple paths to find plutus.json
  const possiblePaths = [
    resolve(process.cwd(), "../../onchain/aiken/plutus.json"),
    resolve(process.cwd(), "../../../storage/onchain/aiken/plutus.json"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../onchain/aiken/plutus.json"),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        continue;
      }
    }
  }
  return null;
}

function getValidatorByTitle(plutusJson: PlutusJson, title: string) {
  return plutusJson.validators.find((v) => v.title === title);
}

/**
 * Convert SnapshotType to on-chain Plutus Data representation
 * Daily = constructor 0, Monthly = constructor 1
 */
function snapshotTypeToPlutusData(type: SnapshotType): Core.PlutusData {
  const index = type === "daily" ? 0n : 1n;
  return Core.PlutusData.newConstrPlutusData(
    new Core.ConstrPlutusData(index, new Core.PlutusList())
  );
}

/**
 * Convert on-chain representation to SnapshotType
 */
function plutusDataToSnapshotType(data: Core.PlutusData): SnapshotType {
  const constr = data.asConstrPlutusData();
  if (!constr) throw new Error("Invalid snapshot type data");
  return constr.getAlternative() === 0n ? "daily" : "monthly";
}

/**
 * Format UTxO reference string
 */
function formatUtxoRef(ref: UtxoRef): string {
  return `${ref.txHash}#${ref.index}`;
}

/**
 * Parse UTxO reference string
 */
function parseUtxoRef(str: string): UtxoRef {
  const [txHash, indexStr] = str.split("#");
  return { txHash, index: parseInt(indexStr, 10) };
}

/**
 * Build the RegistryDatum as Plutus Data
 * RegistryDatum { snapshot_id, snapshot_type, commitment_hash, published_at }
 */
function buildRegistryDatum(
  snapshotId: string,
  snapshotType: SnapshotType,
  commitmentHash: string,
  publishedAt: bigint
): Core.PlutusData {
  const fields = new Core.PlutusList();

  // snapshot_id: ByteArray
  fields.add(Core.PlutusData.newBytes(Buffer.from(snapshotId, "utf-8")));

  // snapshot_type: SnapshotType (constructor)
  fields.add(snapshotTypeToPlutusData(snapshotType));

  // commitment_hash: ByteArray (32 bytes hex)
  fields.add(Core.PlutusData.newBytes(Buffer.from(commitmentHash, "hex")));

  // published_at: Int (POSIX timestamp)
  fields.add(Core.PlutusData.newInteger(publishedAt));

  // Constructor 0 for RegistryDatum
  return Core.PlutusData.newConstrPlutusData(
    new Core.ConstrPlutusData(0n, fields)
  );
}

/**
 * Build the MintRedeemer as Plutus Data
 * MintRedeemer { snapshot_id, snapshot_type, commitment_hash }
 */
function buildMintRedeemer(
  snapshotId: string,
  snapshotType: SnapshotType,
  commitmentHash: string
): Core.PlutusData {
  const fields = new Core.PlutusList();

  // snapshot_id: ByteArray
  fields.add(Core.PlutusData.newBytes(Buffer.from(snapshotId, "utf-8")));

  // snapshot_type: SnapshotType
  fields.add(snapshotTypeToPlutusData(snapshotType));

  // commitment_hash: ByteArray
  fields.add(Core.PlutusData.newBytes(Buffer.from(commitmentHash, "hex")));

  // Constructor 0 for MintRedeemer
  return Core.PlutusData.newConstrPlutusData(
    new Core.ConstrPlutusData(0n, fields)
  );
}

/**
 * Build OutputReference as Plutus Data for parameterizing the minting policy
 * OutputReference { transaction_id: ByteArray, output_index: Int }
 */
function buildOutputReference(txHash: string, index: number): Core.PlutusData {
  const fields = new Core.PlutusList();

  // transaction_id: ByteArray
  fields.add(Core.PlutusData.newBytes(Buffer.from(txHash, "hex")));

  // output_index: Int
  fields.add(Core.PlutusData.newInteger(BigInt(index)));

  // Constructor 0 for OutputReference
  return Core.PlutusData.newConstrPlutusData(
    new Core.ConstrPlutusData(0n, fields)
  );
}

/**
 * Parse RegistryDatum from Plutus Data
 */
function parseRegistryDatum(data: Core.PlutusData): {
  snapshotId: string;
  snapshotType: SnapshotType;
  commitmentHash: string;
  publishedAt: number;
} {
  const constr = data.asConstrPlutusData();
  if (!constr || constr.getAlternative() !== 0n) {
    throw new Error("Invalid RegistryDatum structure");
  }

  const fields = constr.getData();
  if (fields.getLength() !== 4) {
    throw new Error("RegistryDatum should have 4 fields");
  }

  const snapshotIdBytes = fields.get(0).asBoundedBytes();
  const snapshotTypeData = fields.get(1);
  const commitmentHashBytes = fields.get(2).asBoundedBytes();
  const publishedAtInt = fields.get(3).asInteger();

  if (!snapshotIdBytes || !commitmentHashBytes || publishedAtInt === undefined) {
    throw new Error("Invalid RegistryDatum field types");
  }

  return {
    snapshotId: Buffer.from(snapshotIdBytes).toString("utf-8"),
    snapshotType: plutusDataToSnapshotType(snapshotTypeData),
    commitmentHash: Buffer.from(commitmentHashBytes).toString("hex"),
    publishedAt: Number(publishedAtInt),
  };
}

/**
 * Map network ID to Blockfrost network name
 */
function networkToBlockfrostNetwork(network: NetworkId): "cardano-mainnet" | "cardano-preprod" | "cardano-preview" {
  switch (network) {
    case "mainnet":
      return "cardano-mainnet";
    case "preprod":
      return "cardano-preprod";
    case "preview":
      return "cardano-preview";
    default:
      return "cardano-preview";
  }
}

/**
 * Blaze SDK implementation of BlockchainAdapter
 */
export class BlazeAdapter implements BlockchainAdapter {
  private config: AdapterConfig;
  private blaze: Blaze<Provider, HotWallet> | null = null;
  private provider: Provider | null = null;
  private wallet: HotWallet | null = null;
  private validatorAddress: string = "";
  private storageValidatorHash: string = "";
  private storageValidatorScript: Core.Script | null = null;
  private mintPolicyCompiledCode: string = "";
  private plutusJson: PlutusJson | null = null;

  constructor(config: AdapterConfig) {
    this.config = config;
  }

  /**
   * Initialize the adapter (connect to network, load wallet)
   */
  async initialize(): Promise<void> {
    console.log(`Initializing Blaze adapter for ${this.config.network}...`);

    // Load compiled contracts
    this.plutusJson = loadPlutusJson();
    if (!this.plutusJson) {
      throw new Error(
        "Could not load plutus.json. Run 'aiken build' in the onchain/aiken directory first."
      );
    }

    // Get storage validator
    const storageValidator = getValidatorByTitle(this.plutusJson, "storage.storage.spend");
    if (!storageValidator) {
      throw new Error("Storage validator not found in plutus.json");
    }
    this.storageValidatorHash = storageValidator.hash;
    this.storageValidatorScript = Core.Script.newPlutusV3Script(
      new Core.PlutusV3Script(Core.HexBlob(storageValidator.compiledCode))
    );

    // Get mint policy compiled code (parameterized, so we store the template)
    const mintPolicy = getValidatorByTitle(this.plutusJson, "mint.mint.mint");
    if (!mintPolicy) {
      throw new Error("Mint policy not found in plutus.json");
    }
    this.mintPolicyCompiledCode = mintPolicy.compiledCode;

    // Create provider based on config
    if (this.config.provider.type === "blockfrost") {
      if (!this.config.provider.projectId) {
        throw new Error("BLOCKFROST_PROJECT_ID is required for blockfrost provider");
      }
      this.provider = new Blockfrost({
        network: networkToBlockfrostNetwork(this.config.network),
        projectId: this.config.provider.projectId,
      });
    } else {
      throw new Error(`Provider type '${this.config.provider.type}' not yet supported`);
    }

    // Create wallet from seed or private key
    if (this.config.wallet.type === "seed") {
      const entropy = mnemonicToEntropy(this.config.wallet.value, wordlist);
      const masterkey = Bip32PrivateKey.fromBip39Entropy(Buffer.from(entropy), "");
      this.wallet = await HotWallet.fromMasterkey(masterkey.hex(), this.provider);
    } else {
      // For private key, we need to use a different approach
      // HotWallet.fromMasterkey expects a Bip32 key, not Ed25519
      throw new Error("Private key wallet not yet implemented. Use WALLET_SEED instead.");
    }

    // Create Blaze instance
    this.blaze = await Blaze.from(this.provider, this.wallet);

    // Compute validator address
    const networkId = this.config.network === "mainnet" 
      ? Core.NetworkId.Mainnet 
      : Core.NetworkId.Testnet;
    
    const scriptHash = Core.Hash28ByteBase16(this.storageValidatorHash);
    
    // Build script address using addressFromCredential function
    // For script-only addresses (no staking), use enterprise address type
    const credential = Core.Credential.fromCore({
      type: Core.CredentialType.ScriptHash,
      hash: scriptHash,
    });
    const addr = Core.addressFromCredential(networkId, credential);
    this.validatorAddress = addr.toBech32();

    console.log(`  Wallet address: ${this.wallet.address.toBech32()}`);
    console.log(`  Validator address: ${this.validatorAddress}`);
    console.log(`  Storage validator hash: ${this.storageValidatorHash}`);
  }

  getNetwork(): NetworkId {
    return this.config.network;
  }

  async getAddress(): Promise<string> {
    if (!this.wallet) {
      throw new Error("Adapter not initialized");
    }
    return this.wallet.address.toBech32();
  }

  async getUtxos(): Promise<UtxoRef[]> {
    if (!this.provider || !this.wallet) {
      throw new Error("Adapter not initialized");
    }

    const utxos = await this.provider.getUnspentOutputs(this.wallet.address);
    return utxos.map((utxo) => {
      const input = utxo.input();
      return {
        txHash: input.transactionId().toString(),
        index: Number(input.index()),
      };
    });
  }

  async publishCommitment(params: PublishParams): Promise<PublishResult> {
    if (!this.blaze || !this.provider || !this.wallet || !this.storageValidatorScript) {
      throw new Error("Adapter not initialized");
    }

    const { snapshotId, snapshotType, commitmentHash, seedUtxo } = params;

    // Derive asset name from snapshot ID (32 bytes = 64 hex chars)
    const assetNameHex = deriveAssetName(snapshotId);

    // Get seed UTxO (use provided or find first available)
    const seed = seedUtxo ?? (await this.getFirstUtxo());

    console.log("Publishing commitment:");
    console.log(`  Snapshot ID: ${snapshotId}`);
    console.log(`  Type: ${snapshotType}`);
    console.log(`  Commitment Hash: ${commitmentHash}`);
    console.log(`  Asset Name: ${assetNameHex}`);
    console.log(`  Seed UTxO: ${formatUtxoRef(seed)}`);

    // Resolve the seed UTxO
    const seedTxInput = new Core.TransactionInput(
      Core.TransactionId(seed.txHash),
      BigInt(seed.index)
    );
    const [seedUtxoResolved] = await this.provider.resolveUnspentOutputs([seedTxInput]);
    if (!seedUtxoResolved) {
      throw new Error(`Could not resolve seed UTxO: ${formatUtxoRef(seed)}`);
    }

    // Build parameterized minting policy
    // The policy is parameterized by: seed_utxo (OutputReference), validator_hash (ByteArray)
    const seedUtxoData = buildOutputReference(seed.txHash, seed.index);
    const validatorHashBytes = Core.PlutusData.newBytes(
      Buffer.from(this.storageValidatorHash, "hex")
    );

    // Apply parameters to the minting policy
    // For Aiken parameterized validators, we use applyParamsToScript
    const mintScript = this.applyMintPolicyParams(seedUtxoData, validatorHashBytes);
    const policyId = mintScript.hash();

    console.log(`  Policy ID: ${policyId}`);

    // Build datum
    const publishedAt = BigInt(Math.floor(Date.now() / 1000));
    const datum = buildRegistryDatum(snapshotId, snapshotType, commitmentHash, publishedAt);

    // Build redeemer
    const redeemer = buildMintRedeemer(snapshotId, snapshotType, commitmentHash);

    // Build the mint value
    const assetName = Core.AssetName(assetNameHex);
    const mintAssets = new Map<Core.AssetName, bigint>();
    mintAssets.set(assetName, 1n);

    // Calculate min ADA for the output
    const minLovelace = 2_000_000n; // ~2 ADA should be sufficient for datum + NFT

    // Build NFT value for the output
    // Cast policyId to PolicyId type
    const policyIdTyped = Core.PolicyId(policyId);
    const nftValue = Core.Value.fromCore({
      coins: minLovelace,
      assets: new Map([[Core.AssetId.fromParts(policyIdTyped, assetName), 1n]]),
    });

    // Get validator address
    const validatorAddr = Core.Address.fromBech32(this.validatorAddress);

    // Build transaction
    const tx = this.blaze
      .newTransaction()
      .addInput(seedUtxoResolved) // Consume the seed UTxO
      .addMint(policyIdTyped, mintAssets, redeemer) // Mint the NFT
      .provideScript(mintScript) // Provide the minting policy script
      .lockAssets(validatorAddr, nftValue, datum) // Lock NFT + datum at validator
      .provideScript(this.storageValidatorScript); // Provide validator script for reference

    // Complete, sign, and submit
    console.log("  Building transaction...");
    const completedTx = await tx.complete();
    
    console.log("  Signing transaction...");
    const signedTx = await this.blaze.signTransaction(completedTx);
    
    console.log("  Submitting transaction...");
    const txId = await this.blaze.submitTransaction(signedTx);
    
    console.log(`  Transaction submitted: ${txId}`);
    console.log("  Waiting for confirmation...");

    // Wait for confirmation
    const confirmed = await this.provider.awaitTransactionConfirmation(txId, 120_000);
    if (!confirmed) {
      throw new Error(`Transaction ${txId} was not confirmed within timeout`);
    }

    console.log("  ✓ Transaction confirmed!");

    // The output index at the validator is typically the first output (index 0)
    // but we should find it properly
    const outputIndex = 0; // Simplified - in production, parse the tx to find it

    return {
      txId: txId.toString(),
      utxoRef: { txHash: txId.toString(), index: outputIndex },
      policyId: policyId.toString(),
      assetName: assetNameHex,
    };
  }

  async getCommitment(params: QueryParams): Promise<OnChainCommitment | null> {
    if (!this.provider) {
      throw new Error("Adapter not initialized");
    }

    const { snapshotId, utxoRef, policyId, assetName: providedAssetName } = params;

    // Derive asset name if snapshot ID provided
    const assetName = snapshotId ? deriveAssetName(snapshotId) : providedAssetName;

    console.log("Querying commitment:");
    if (snapshotId) console.log(`  Snapshot ID: ${snapshotId}`);
    if (utxoRef) console.log(`  UTxO Ref: ${formatUtxoRef(utxoRef)}`);
    if (policyId) console.log(`  Policy ID: ${policyId}`);
    if (assetName) console.log(`  Asset Name: ${assetName}`);

    const validatorAddr = Core.Address.fromBech32(this.validatorAddress);

    try {
      // Query UTxOs at validator address
      let utxos: Core.TransactionUnspentOutput[];

      if (policyId && assetName) {
        // Query by specific asset
        const assetId = Core.AssetId.fromParts(
          Core.PolicyId(policyId),
          Core.AssetName(assetName)
        );
        utxos = await this.provider.getUnspentOutputsWithAsset(validatorAddr, assetId);
      } else {
        // Get all UTxOs at validator and filter
        utxos = await this.provider.getUnspentOutputs(validatorAddr);
      }

      if (utxos.length === 0) {
        console.log("  No matching UTxOs found");
        return null;
      }

      // If specific UTxO ref provided, filter to that one
      if (utxoRef) {
        utxos = utxos.filter((u) => {
          const input = u.input();
          return (
            input.transactionId().toString() === utxoRef.txHash &&
            Number(input.index()) === utxoRef.index
          );
        });
      }

      if (utxos.length === 0) {
        console.log("  No matching UTxOs found after filtering");
        return null;
      }

      // Parse the first matching UTxO
      const utxo = utxos[0];
      const output = utxo.output();
      const input = utxo.input();
      const datumData = output.datum();

      if (!datumData) {
        console.log("  UTxO has no datum");
        return null;
      }

      // Parse inline datum
      let parsedDatum: ReturnType<typeof parseRegistryDatum>;
      try {
        // The datum should be inline for our validator
        // Datum can be PlutusData or DatumHash, we need PlutusData for inline datums
        const plutusData = datumData as unknown as Core.PlutusData;
        parsedDatum = parseRegistryDatum(plutusData);
      } catch (e) {
        console.log(`  Failed to parse datum: ${e}`);
        return null;
      }

      const result: OnChainCommitment = {
        snapshotId: parsedDatum.snapshotId,
        snapshotType: parsedDatum.snapshotType,
        commitmentHash: parsedDatum.commitmentHash,
        publishedAt: parsedDatum.publishedAt,
        txId: input.transactionId().toString(),
        utxoRef: `${input.transactionId().toString()}#${input.index()}`,
      };

      console.log("  ✓ Found commitment:");
      console.log(`    Snapshot ID: ${result.snapshotId}`);
      console.log(`    Type: ${result.snapshotType}`);
      console.log(`    Hash: ${result.commitmentHash}`);

      return result;
    } catch (error) {
      console.error(`  Error querying commitment: ${error}`);
      return null;
    }
  }

  getValidatorAddress(): string {
    if (!this.validatorAddress) {
      throw new Error("Validator address not initialized");
    }
    return this.validatorAddress;
  }

  getPolicyId(seedUtxo: UtxoRef): string {
    const seedUtxoData = buildOutputReference(seedUtxo.txHash, seedUtxo.index);
    const validatorHashBytes = Core.PlutusData.newBytes(
      Buffer.from(this.storageValidatorHash, "hex")
    );
    const mintScript = this.applyMintPolicyParams(seedUtxoData, validatorHashBytes);
    return mintScript.hash();
  }

  /**
   * Apply parameters to the minting policy script
   * This creates a new script with the parameters applied
   */
  private applyMintPolicyParams(
    seedUtxo: Core.PlutusData,
    validatorHash: Core.PlutusData
  ): Core.Script {
    const appliedCode = applyParams(
      Core.HexBlob(this.mintPolicyCompiledCode),
      seedUtxo,
      validatorHash
    );
    
    return Core.Script.newPlutusV3Script(
      new Core.PlutusV3Script(appliedCode)
    );
  }

  /**
   * Get the first available UTxO from the wallet
   */
  private async getFirstUtxo(): Promise<UtxoRef> {
    const utxos = await this.getUtxos();
    if (utxos.length === 0) {
      throw new Error("No UTxOs available in wallet");
    }
    return utxos[0];
  }
}

/**
 * Create a Blaze adapter with the given configuration
 */
export async function createBlazeAdapter(config: AdapterConfig): Promise<BlockchainAdapter> {
  const adapter = new BlazeAdapter(config);
  await adapter.initialize();
  return adapter;
}

/**
 * Create adapter configuration from environment variables
 */
export function configFromEnv(): AdapterConfig {
  const network = (process.env.CARDANO_NETWORK ?? "preview") as NetworkId;

  const walletSeed = process.env.WALLET_SEED;
  const walletKey = process.env.WALLET_PRIVATE_KEY;

  if (!walletSeed && !walletKey) {
    throw new Error("Either WALLET_SEED or WALLET_PRIVATE_KEY must be set");
  }

  const providerType = (process.env.PROVIDER_TYPE ?? "blockfrost") as "blockfrost" | "koios" | "ogmios";
  const projectId = process.env.BLOCKFROST_PROJECT_ID;

  if (providerType === "blockfrost" && !projectId) {
    throw new Error("BLOCKFROST_PROJECT_ID must be set for blockfrost provider");
  }

  return {
    network,
    wallet: walletSeed
      ? { type: "seed", value: walletSeed }
      : { type: "private-key", value: walletKey! },
    provider: {
      type: providerType,
      projectId,
    },
  };
}
