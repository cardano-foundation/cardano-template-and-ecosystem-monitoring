// Blockchain interaction module for IoT Sentinel

import {
  BlockfrostProvider,
  MeshWallet,
  MeshTxBuilder,
  serializePlutusScript,
  deserializeAddress,
  mConStr0,
  stringToHex,
  PlutusScript,
  UTxO,
} from '@meshsdk/core';
import { createHash } from 'crypto';
import { SensorData, IoTRecordDatum, TxResult, StatusResult } from './types';

let contractScript: PlutusScript | null = null;
let scriptAddress: string | null = null;

export function initContract(compiledScript: string, network: 'preview' | 'preprod' | 'mainnet' = 'preview'): void {
  contractScript = {
    code: compiledScript,
    version: 'V3' as const,
  };
  
  scriptAddress = serializePlutusScript(contractScript, undefined, network === 'mainnet' ? 1 : 0).address;
  console.log(`Contract initialized at: ${scriptAddress}`);
}

export function getScriptAddress(): string {
  if (!scriptAddress) throw new Error('Contract not initialized');
  return scriptAddress;
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
