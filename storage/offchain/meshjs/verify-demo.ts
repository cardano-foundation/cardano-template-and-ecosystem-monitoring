// IoT Sentinel - Data Verification Tool

import { BlockfrostProvider } from '@meshsdk/core';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  loadSensorReading, listReadingFiles, loadRegistry,
  hashSensorData, findRecordByFilename, updateRegistryRecord,
  RegistryRecord,
} from './lib/data-manager';
import { initContract, readRecords, getScriptAddress } from './lib/interaction';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface VerificationResult {
  filename: string;
  recordId: string | null;
  isValid: boolean;
  originalHash: string | null;
  currentHash: string;
  hasTxHash: boolean;
  source: 'registry' | 'blockchain';
  details?: string;
}

interface BlockchainRecord {
  data_hash: string;
  device_id: string;
  timestamp: number;
  status_code: number;
  tx_hash?: string;
}

function decodeCborDatum(cborHex: string): any[] | null {
  try {
    if (!cborHex.startsWith('d8799f') || !cborHex.endsWith('ff')) return null;
    
    const dataHex = cborHex.slice(6, -2);
    const fields: any[] = [];
    let pos = 0;
    
    while (pos < dataHex.length) {
      const byte = parseInt(dataHex.slice(pos, pos + 2), 16);
      const majorType = byte >> 5;
      const additionalInfo = byte & 0x1f;
      
      if (majorType === 2) {
        let length: number, dataStart: number;
        
        if (additionalInfo < 24) {
          length = additionalInfo;
          dataStart = pos + 2;
        } else if (additionalInfo === 24) {
          length = parseInt(dataHex.slice(pos + 2, pos + 4), 16);
          dataStart = pos + 4;
        } else if (additionalInfo === 25) {
          length = parseInt(dataHex.slice(pos + 2, pos + 6), 16);
          dataStart = pos + 6;
        } else {
          length = parseInt(dataHex.slice(pos + 2, pos + 4), 16);
          dataStart = pos + 4;
        }
        
        fields.push({ type: 'bytes', value: dataHex.slice(dataStart, dataStart + length * 2) });
        pos = dataStart + length * 2;
      } else if (majorType === 0) {
        let value: number;
        
        if (additionalInfo < 24) { value = additionalInfo; pos += 2; }
        else if (additionalInfo === 24) { value = parseInt(dataHex.slice(pos + 2, pos + 4), 16); pos += 4; }
        else if (additionalInfo === 25) { value = parseInt(dataHex.slice(pos + 2, pos + 6), 16); pos += 6; }
        else if (additionalInfo === 26) { value = parseInt(dataHex.slice(pos + 2, pos + 10), 16); pos += 10; }
        else { value = 0; pos += 2; }
        
        fields.push({ type: 'int', value });
      } else {
        pos += 2;
      }
    }
    
    return fields;
  } catch (error) {
    return null;
  }
}

function parseDataHashFromDatum(plutusData: any): BlockchainRecord | null {
  try {
    let fields: any[] | null = null;
    
    if (typeof plutusData === 'string' && plutusData.startsWith('d8799f')) {
      fields = decodeCborDatum(plutusData);
    } else if (plutusData?.fields && Array.isArray(plutusData.fields)) {
      fields = plutusData.fields.map((f: any) => {
        if (f.bytes) return { type: 'bytes', value: f.bytes };
        if (f.int !== undefined) return { type: 'int', value: f.int };
        return { type: 'unknown', value: f };
      });
    }
    
    if (!fields || fields.length < 5) return null;
    
    return {
      device_id: Buffer.from(String(fields[1]?.value || ''), 'hex').toString('utf8'),
      timestamp: Number(fields[2]?.value || 0),
      data_hash: String(fields[3]?.value || ''),
      status_code: Number(fields[4]?.value || 0),
    };
  } catch (error) {
    return null;
  }
}

async function fetchBlockchainRecords(provider: BlockfrostProvider): Promise<Map<string, BlockchainRecord>> {
  const hashMap = new Map<string, BlockchainRecord>();
  
  try {
    const utxos = await readRecords(provider);
    
    for (const utxo of utxos) {
      if (utxo.output.plutusData) {
        const record = parseDataHashFromDatum(utxo.output.plutusData);
        if (record?.data_hash) {
          hashMap.set(record.data_hash, { ...record, tx_hash: utxo.input.txHash });
        }
      }
    }
  } catch (error) {
    console.error('Error fetching blockchain records:', error);
  }
  
  return hashMap;
}

function verifyFileAgainstBlockchain(filename: string, blockchainRecords: Map<string, BlockchainRecord>): VerificationResult {
  const data = loadSensorReading(filename);
  
  if (!data) {
    return { filename, recordId: null, isValid: false, originalHash: null, currentHash: '', hasTxHash: false, source: 'blockchain', details: 'File not found' };
  }

  const currentHash = hashSensorData(data);
  const blockchainRecord = blockchainRecords.get(currentHash);
  
  if (blockchainRecord) {
    return { filename, recordId: null, isValid: true, originalHash: currentHash, currentHash, hasTxHash: true, source: 'blockchain', details: `Verified on chain (tx: ${blockchainRecord.tx_hash?.substring(0, 16)}...)` };
  }
  
  const record = findRecordByFilename(filename);
  
  if (record?.tx_hash) {
    return { filename, recordId: record.id, isValid: false, originalHash: record.blockchain_hash, currentHash, hasTxHash: true, source: 'blockchain', details: 'TAMPERED! Hash mismatch' };
  }
  
  return { filename, recordId: record?.id || null, isValid: false, originalHash: null, currentHash, hasTxHash: false, source: 'blockchain', details: 'Not on blockchain yet' };
}

function verifyFileFromRegistry(filename: string): VerificationResult {
  const data = loadSensorReading(filename);
  if (!data) {
    return { filename, recordId: null, isValid: false, originalHash: null, currentHash: '', hasTxHash: false, source: 'registry', details: 'File not found' };
  }

  const currentHash = hashSensorData(data);
  const record = findRecordByFilename(filename);

  if (!record) {
    return { filename, recordId: null, isValid: false, originalHash: null, currentHash, hasTxHash: false, source: 'registry', details: 'Not in registry' };
  }

  if (!record.blockchain_hash) {
    return { filename, recordId: record.id, isValid: false, originalHash: null, currentHash, hasTxHash: false, source: 'registry', details: 'No blockchain hash yet' };
  }

  const isValid = currentHash === record.blockchain_hash;
  return { filename, recordId: record.id, isValid, originalHash: record.blockchain_hash, currentHash, hasTxHash: !!record.tx_hash, source: 'registry', details: isValid ? 'Verified' : 'TAMPERED!' };
}

function printResult(result: VerificationResult): void {
  console.log(`\n${result.filename}`);
  console.log(`  Source: ${result.source === 'blockchain' ? 'Blockchain' : 'Registry'} | On-chain: ${result.hasTxHash ? 'Yes' : 'No'}`);
  
  if (result.originalHash) {
    console.log(`  Chain: ${result.originalHash.substring(0, 24)}...`);
    console.log(`  Local: ${result.currentHash.substring(0, 24)}...`);
  }
  
  console.log(`  ${result.isValid ? '[VERIFIED]' : '[FAILED]'} - ${result.details}`);
}

function demonstrateTampering(): void {
  console.log('\nTAMPERING DETECTION DEMO\n');

  const files = listReadingFiles();
  if (files.length === 0) { console.log('No files found'); return; }

  let testFile: string | null = null;
  let record: RegistryRecord | undefined;

  for (const file of files) {
    const rec = findRecordByFilename(file);
    if (rec?.blockchain_hash) { testFile = file; record = rec; break; }
  }

  if (!testFile || !record?.blockchain_hash) {
    console.log('No files with blockchain hash found. Run npm run dev first.');
    return;
  }

  const originalData = loadSensorReading(testFile);
  if (!originalData) { console.log('Could not load test file'); return; }

  console.log(`Testing: ${testFile}`);
  console.log(`Original hash: ${record.blockchain_hash.substring(0, 32)}...`);

  console.log('\nTest 1: Original Data');
  const hash1 = hashSensorData(originalData);
  console.log(`  ${hash1 === record.blockchain_hash ? 'VALID' : 'INVALID'}`);

  console.log('\nTest 2: Temperature Changed (to 45C)');
  const hash2 = hashSensorData({ ...originalData, temperature: 45 });
  console.log(`  ${hash2 === record.blockchain_hash ? 'VALID' : 'TAMPERED!'}`);

  console.log('\nTest 3: Current Changed');
  const hash3 = hashSensorData({ ...originalData, phase_current: { R: 50, S: 49, T: 51 } });
  console.log(`  ${hash3 === record.blockchain_hash ? 'VALID' : 'TAMPERED!'}`);

  console.log('\nAny change produces different hash. Blockchain stores original immutably.\n');
}

async function main(): Promise<void> {
  console.log('\nIoT SENTINEL - Data Verification\n');

  const args = process.argv.slice(2);
  const demoMode = args.includes('--demo');
  const blockchainMode = args.includes('--blockchain');

  if (demoMode) { demonstrateTampering(); return; }

  console.log(blockchainMode ? 'BLOCKCHAIN MODE (Tamper-Proof)' : 'REGISTRY MODE (Local)');
  if (!blockchainMode) console.log('Use --blockchain for true verification\n');

  let blockchainRecords: Map<string, BlockchainRecord> | null = null;
  
  if (blockchainMode) {
    const apiKey = process.env.BLOCKFROST_API_KEY;
    const network = (process.env.NETWORK || 'preview') as 'preview' | 'preprod' | 'mainnet';
    
    if (!apiKey) {
      console.log('BLOCKFROST_API_KEY not found. Using registry...\n');
    } else {
      const aikenPath = path.join(__dirname, '..', '..', 'onchain', 'aiken', 'plutus.json');
      if (!fs.existsSync(aikenPath)) { console.log('plutus.json not found'); return; }
      
      const plutusJson = JSON.parse(fs.readFileSync(aikenPath, 'utf8'));
      const validator = plutusJson.validators.find((v: any) => v.title.includes('storage'));
      if (!validator) { console.log('Validator not found'); return; }
      
      initContract(validator.compiledCode, network);
      
      const provider = new BlockfrostProvider(apiKey);
      
      console.log('Fetching from blockchain...');
      blockchainRecords = await fetchBlockchainRecords(provider);
      console.log(`Found ${blockchainRecords.size} hash(es) on-chain\n`);
    }
  }

  const filesToVerify = listReadingFiles();
  if (filesToVerify.length === 0) { console.log('No files to verify'); return; }

  console.log(`Verifying ${filesToVerify.length} file(s)...`);

  const results: VerificationResult[] = [];
  
  for (const file of filesToVerify) {
    const result = blockchainMode && blockchainRecords 
      ? verifyFileAgainstBlockchain(file, blockchainRecords)
      : verifyFileFromRegistry(file);
    
    results.push(result);
    printResult(result);

    if (result.recordId && result.isValid) {
      updateRegistryRecord(result.recordId, { verified: true });
    }
  }

  const verified = results.filter(r => r.isValid).length;
  const tampered = results.filter(r => !r.isValid && r.hasTxHash).length;

  console.log('\n========================================');
  console.log(`SUMMARY: ${verified}/${results.length} verified | ${tampered} tampered`);
  console.log('========================================\n');

  if (tampered > 0) console.log('CRITICAL: Data tampering detected!\n');
  if (!blockchainMode) console.log('Run with --blockchain for tamper-proof verification\n');
}

main().catch(console.error);
