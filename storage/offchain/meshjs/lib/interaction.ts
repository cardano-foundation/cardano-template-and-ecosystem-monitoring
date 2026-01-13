// Blockchain interaction module for IoT Sentinel
// Implements UTXO Recycling for cost-efficient data storage

import {
  BlockfrostProvider,
  MeshWallet,
  MeshTxBuilder,
  serializePlutusScript,
  deserializeAddress,
  mConStr0,
  mConStr1,
  mConStr2,
  stringToHex,
  PlutusScript,
  UTxO,
  deserializeDatum,
} from '@meshsdk/core';
import { createHash } from 'crypto';
import { SensorData, IoTRecordDatum, TxResult, StatusResult } from './types';

// Redeemer constants matching Aiken contract (StorageAction enum)
// pub type StorageAction { Lock, Update, Spend }
const REDEEMER_LOCK = mConStr0([]);    // Lock = constructor 0
const REDEEMER_UPDATE = mConStr1([]);  // Update = constructor 1  
const REDEEMER_SPEND = mConStr2([]);   // Spend = constructor 2

let contractScript: PlutusScript | null = null;
let scriptAddress: string | null = null;
let scriptHash: string | null = null;

export function initContract(
  compiledScript: string, 
  network: 'preview' | 'preprod' | 'mainnet' = 'preview',
  validatorHash?: string  // Script hash from plutus.json
): void {
  contractScript = {
    code: compiledScript,
    version: 'V3' as const,
  };
  
  // IMPORTANT: Use address from Aiken CLI, not MeshJS serializePlutusScript
  // MeshJS has a bug generating incorrect address for Plutus V3 scripts
  // Correct address verified with: aiken blueprint address . -v storage
  if (network === 'preview') {
    scriptAddress = 'addr_test1wrfaus9yayyr76ypyhyuzgu62370a2numc0tr2kfutezedqeh2vfg';
  } else if (network === 'mainnet') {
    // For mainnet, use: aiken blueprint address . -v storage --mainnet
    throw new Error('Mainnet address not configured. Generate with Aiken CLI first.');
  } else {
    scriptAddress = 'addr_test1wrfaus9yayyr76ypyhyuzgu62370a2numc0tr2kfutezedqeh2vfg';
  }
  
  scriptHash = validatorHash || null;
  console.log(`Contract initialized at: ${scriptAddress}`);
  if (scriptHash) {
    console.log(`Script hash: ${scriptHash}`);
  }
}

export function getScriptAddress(): string {
  if (!scriptAddress) throw new Error('Contract not initialized');
  return scriptAddress;
}

export function getScriptHash(): string | null {
  return scriptHash;
}

export function hashSensorData(data: SensorData): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export function createDatum(
  ownerPkh: string,
  deviceId: string,
  timestamp: number,
  dataHash: string,
  statusCode: number
): IoTRecordDatum {
  return {
    owner: ownerPkh,
    device_id: stringToHex(deviceId),
    timestamp,
    data_hash: dataHash,
    status_code: statusCode,
  };
}

function buildPlutusData(datum: IoTRecordDatum): any {
  return mConStr0([
    datum.owner,
    datum.device_id,
    datum.timestamp,
    datum.data_hash,
    datum.status_code,
  ]);
}

export async function lockData(
  provider: BlockfrostProvider,
  wallet: MeshWallet,
  sensorData: SensorData,
  status: StatusResult,
  lovelaceAmount: string = '2000000'
): Promise<TxResult> {
  try {
    if (!scriptAddress || !contractScript) {
      throw new Error('Contract not initialized');
    }

    const walletAddress = wallet.getChangeAddress();
    const { pubKeyHash: ownerPkh } = deserializeAddress(walletAddress);

    const timestamp = sensorData.timestamp || Math.floor(Date.now() / 1000);
    const dataWithTimestamp = { ...sensorData, timestamp };
    const dataHash = hashSensorData(dataWithTimestamp);

    console.log(`\nLocking data to blockchain...`);
    console.log(`  Device: ${sensorData.device_id}`);
    console.log(`  Status: ${status.name} (Code: ${status.code})`);
    console.log(`  Hash: ${dataHash}`);

    const datum = createDatum(ownerPkh, sensorData.device_id, timestamp, dataHash, status.code);

    const txBuilder = new MeshTxBuilder({ fetcher: provider, submitter: provider });
    const utxos = await wallet.getUtxos();
    
    await txBuilder
      .txOut(scriptAddress, [{ unit: 'lovelace', quantity: lovelaceAmount }])
      .txOutInlineDatumValue(buildPlutusData(datum))
      .changeAddress(walletAddress)
      .selectUtxosFrom(utxos)
      .complete();

    const signedTx = await wallet.signTx(txBuilder.txHex);
    const txHash = await provider.submitTx(signedTx);

    console.log(`  Submitted! Tx: ${txHash}`);
    return { txHash, success: true, message: `Data locked. Hash: ${dataHash}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`  Failed: ${message}`);
    return { txHash: '', success: false, message };
  }
}

/**
 * Find UTxO owned by this wallet at the script address
 * Returns the oldest UTxO for recycling (FIFO)
 * Only returns UTxOs that can be spent by current script version
 */
export async function findOwnedUtxo(
  provider: BlockfrostProvider,
  wallet: MeshWallet,
  debug: boolean = false
): Promise<UTxO | null> {
  if (!scriptAddress || !contractScript) throw new Error('Contract not initialized');
  
  const walletAddress = wallet.getChangeAddress();
  const { pubKeyHash: ownerPkh } = deserializeAddress(walletAddress);
  
  // Get script hash from address (this is the correct hash for UTxOs at this address)
  const { scriptHash: addressScriptHash } = deserializeAddress(scriptAddress);
  
  // Get script hash from current compiled script
  const currentScriptHash = scriptHash;
  
  const utxos = await provider.fetchAddressUTxOs(scriptAddress);
  
  if (debug) {
    console.log(`  Debug: Found ${utxos.length} UTxOs at script address`);
    console.log(`  Debug: Address script hash: ${addressScriptHash}`);
    console.log(`  Debug: Current compiled script hash: ${currentScriptHash}`);
    console.log(`  Debug: Looking for owner: ${ownerPkh}`);
  }
  
  // Check if script hashes match - if not, we can't spend any UTxOs
  if (currentScriptHash && currentScriptHash !== addressScriptHash) {
    if (debug) {
      console.log(`  Debug: Script hash mismatch! Cannot recycle UTxOs.`);
      console.log(`  Debug: UTxOs were locked with a different script version.`);
    }
    return null;  // Can't recycle - script was recompiled
  }
  
  // Find UTxOs owned by this wallet (check datum.owner)
  for (const utxo of utxos) {
    if (utxo.output.plutusData) {
      try {
        let plutusData = utxo.output.plutusData as any;
        
        // If plutusData is a CBOR hex string, deserialize it
        if (typeof plutusData === 'string') {
          plutusData = deserializeDatum(plutusData);
        }
        
        if (debug) {
          console.log(`  Debug: UTxO ${utxo.input.txHash.substring(0, 16)}...`);
          console.log(`  Debug: Deserialized datum:`, JSON.stringify(plutusData).substring(0, 100));
        }
        
        // Handle Constr datum: { constructor: 0, fields: [...] }
        const fields = plutusData?.fields;
        
        if (fields && fields.length >= 1) {
          // First field is owner pkh (as bytes)
          const ownerField = fields[0];
          const datumOwner = ownerField?.bytes || ownerField;
          
          if (debug) {
            console.log(`  Debug: Datum owner: ${datumOwner}`);
            console.log(`  Debug: Looking for: ${ownerPkh}`);
            console.log(`  Debug: Match: ${datumOwner === ownerPkh}`);
          }
          
          if (datumOwner === ownerPkh) {
            return utxo;  // Return first owned UTxO (oldest)
          }
        }
      } catch (e) {
        if (debug) console.log(`  Debug: Parse error:`, e);
        // Skip if datum parsing fails
      }
    }
  }
  
  return null;
}

/**
 * UTXO Recycling: Spend old UTxO + Lock new data in single transaction
 * 
 * Cost breakdown:
 * - First data: Fee (~0.2 ADA) + Deposit (2 ADA) = ~2.2 ADA
 * - Subsequent: Fee (~0.3 ADA) only! Deposit recycled from previous UTxO
 * 
 * Net savings: ~2 ADA per transaction after the first one
 */
export async function lockDataWithRecycling(
  provider: BlockfrostProvider,
  wallet: MeshWallet,
  sensorData: SensorData,
  status: StatusResult,
  lovelaceAmount: string = '2000000'
): Promise<TxResult> {
  try {
    if (!scriptAddress || !contractScript) {
      throw new Error('Contract not initialized');
    }

    const walletAddress = wallet.getChangeAddress();
    const { pubKeyHash: ownerPkh } = deserializeAddress(walletAddress);

    const timestamp = sensorData.timestamp || Math.floor(Date.now() / 1000);
    const dataWithTimestamp = { ...sensorData, timestamp };
    const dataHash = hashSensorData(dataWithTimestamp);

    // Try to find an old UTxO to recycle (set debug=false for production)
    const oldUtxo = await findOwnedUtxo(provider, wallet, false);
    
    const datum = createDatum(ownerPkh, sensorData.device_id, timestamp, dataHash, status.code);
    const txBuilder = new MeshTxBuilder({ fetcher: provider, submitter: provider });
    const walletUtxos = await wallet.getUtxos();

    if (oldUtxo) {
      // RECYCLING MODE: Spend old UTxO + Lock new data
      console.log(`\n♻️  UTXO Recycling Mode`);
      console.log(`  Spending old UTxO: ${oldUtxo.input.txHash.substring(0, 16)}...`);
      console.log(`  Recycling deposit: ${Number(oldUtxo.output.amount[0].quantity) / 1_000_000} ADA`);
      console.log(`  Net cost: ~0.3 ADA (fee only)\n`);
      
      console.log(`Locking new data to blockchain...`);
      console.log(`  Device: ${sensorData.device_id}`);
      console.log(`  Status: ${status.name} (Code: ${status.code})`);
      console.log(`  Hash: ${dataHash}`);

      // Find a pure ADA UTxO for collateral (required for Plutus scripts)
      const collateralUtxo = walletUtxos.find(u => 
        u.output.amount.length === 1 && 
        u.output.amount[0].unit === 'lovelace' &&
        Number(u.output.amount[0].quantity) >= 5_000_000
      );
      
      if (!collateralUtxo) {
        throw new Error('No suitable collateral UTxO found. Need at least 5 ADA pure UTxO.');
      }

      // Build transaction: Spend old + Lock new
      await txBuilder
        // Spend the old UTxO (reclaim the 2 ADA deposit)
        .spendingPlutusScriptV3()
        .txIn(oldUtxo.input.txHash, oldUtxo.input.outputIndex)
        .txInInlineDatumPresent()
        .txInRedeemerValue(REDEEMER_SPEND)
        .txInScript(contractScript.code)
        // Lock new data with recycled deposit
        .txOut(scriptAddress, [{ unit: 'lovelace', quantity: lovelaceAmount }])
        .txOutInlineDatumValue(buildPlutusData(datum))
        // Collateral for Plutus script execution
        .txInCollateral(
          collateralUtxo.input.txHash,
          collateralUtxo.input.outputIndex,
          collateralUtxo.output.amount,
          collateralUtxo.output.address
        )
        // Require owner signature
        .requiredSignerHash(ownerPkh)
        .changeAddress(walletAddress)
        .selectUtxosFrom(walletUtxos)
        .complete({
          // Force protocol parameter evaluation
          customizedTx: undefined,
        });
    } else {
      // FIRST TIME: No UTxO to recycle, create new one
      console.log(`\n📦 First-time Lock (no UTxO to recycle)`);
      console.log(`  Deposit required: ${Number(lovelaceAmount) / 1_000_000} ADA`);
      console.log(`  This deposit will be recycled in next transaction\n`);
      
      console.log(`Locking data to blockchain...`);
      console.log(`  Device: ${sensorData.device_id}`);
      console.log(`  Status: ${status.name} (Code: ${status.code})`);
      console.log(`  Hash: ${dataHash}`);

      await txBuilder
        .txOut(scriptAddress, [{ unit: 'lovelace', quantity: lovelaceAmount }])
        .txOutInlineDatumValue(buildPlutusData(datum))
        .changeAddress(walletAddress)
        .selectUtxosFrom(walletUtxos)
        .complete();
    }

    const signedTx = await wallet.signTx(txBuilder.txHex);
    const txHash = await provider.submitTx(signedTx);

    console.log(`  Submitted! Tx: ${txHash}`);
    
    const message = oldUtxo 
      ? `Data locked (recycled). Net cost: ~0.3 ADA. Hash: ${dataHash}`
      : `Data locked (new deposit). Hash: ${dataHash}`;
    
    return { txHash, success: true, message };
  } catch (error: any) {
    // Better error logging
    let message = 'Unknown error';
    if (error instanceof Error) {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error?.message) {
      message = error.message;
    }
    console.error(`  Failed: ${message}`);
    if (error?.stack) console.error(`  Stack: ${error.stack.substring(0, 200)}`);
    return { txHash: '', success: false, message };
  }
}

export async function readRecords(provider: BlockfrostProvider): Promise<UTxO[]> {
  if (!scriptAddress) throw new Error('Contract not initialized');
  console.log(`\nReading from: ${scriptAddress}`);
  const utxos = await provider.fetchAddressUTxOs(scriptAddress);
  console.log(`  Found ${utxos.length} record(s)`);
  return utxos;
}

export function verifyRecord(originalData: SensorData, storedHash: string): boolean {
  const computed = hashSensorData(originalData);
  const valid = computed === storedHash;
  console.log(`\nVerification: ${valid ? 'VALID' : 'INVALID'}`);
  return valid;
}
