// IoT Sentinel - Complete Demo with Device Authentication
// 1. Generate sensor data from IoT device
// 2. Create digital signature (device signs data)
// 3. Verify signature (system validates)
// 4. Submit to Cardano blockchain

import { BlockfrostProvider, MeshWallet } from '@meshsdk/core';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

import { SensorData } from './lib/types';
import { analyzeStatus, printStatus } from './lib/analyzer';
import { initContract, lockData, readRecords, getScriptAddress } from './lib/interaction';
import {
  loadSensorReading, listReadingFiles, loadRegistry,
  updateRegistryRecord, hashSensorData, printRegistrySummary,
  saveSensorReading, addToRegistry,
} from './lib/data-manager';
import {
  registerDevice, createAuthenticatedData, verifyAuthenticatedData,
  isDeviceRegistered, loadDeviceRegistry, printDeviceRegistry,
} from './lib/device-auth';
import {
  getDeviceKeySecure, setDeviceKeySecure, printSecurityStatus,
} from './lib/secure-storage';

dotenv.config();

const CONFIG = {
  BLOCKFROST_API_KEY: process.env.BLOCKFROST_API_KEY || '',
  WALLET_MNEMONIC: process.env.WALLET_MNEMONIC || '',
  NETWORK: (process.env.NETWORK || 'preview') as 'preview' | 'preprod' | 'mainnet',
};

const DEVICE_ID = 'TRAFO-SINJAI-01';

function printBanner(): void {
  console.log('\n========================================');
  console.log('  IoT SENTINEL - Complete Demo');
  console.log('  Device Auth + Blockchain Storage');
  console.log('========================================\n');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Load device private key (now encrypted)
function loadDeviceKey(deviceId: string): string | null {
  return getDeviceKeySecure(deviceId);
}

// Save device private key (now encrypted)
function saveDeviceKey(deviceId: string, privateKey: string): void {
  setDeviceKeySecure(deviceId, privateKey);
  console.log('Private key stored with AES-256 encryption');
}

// Generate random sensor data
function generateSensorData(): SensorData {
  const rand = (base: number, range: number) => 
    Math.round((base + (Math.random() - 0.5) * range * 2) * 10) / 10;
  
  return {
    device_id: DEVICE_ID,
    phase_voltage: { R: rand(220, 3), S: rand(219, 3), T: rand(221, 3) },
    phase_current: { R: rand(55, 10), S: rand(54, 10), T: rand(56, 10) },
    temperature: rand(68, 8),
    inom_setting: 100,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

// Step 1: Ensure device is registered
function ensureDeviceRegistered(): string {
  console.log('STEP 1: Device Registration Check');
  console.log('----------------------------------');
  
  if (isDeviceRegistered(DEVICE_ID)) {
    console.log(`Device ${DEVICE_ID} already registered`);
    const privateKey = loadDeviceKey(DEVICE_ID);
    if (privateKey) {
      console.log('Private key found on device');
      return privateKey;
    }
  }
  
  console.log(`Registering new device: ${DEVICE_ID}`);
  const { privateKey } = registerDevice(DEVICE_ID, '3-Phase Transformer Sinjai');
  saveDeviceKey(DEVICE_ID, privateKey);
  console.log('Device registered successfully');
  console.log('- Public key stored in system');
  console.log('- Private key stored on device');
  
  return privateKey;
}

// Step 2: Generate and sign sensor data
function generateAndSignData(privateKey: string): { data: SensorData; signatureProof: any } | null {
  console.log('\nSTEP 2: IoT Device - Generate & Sign Data');
  console.log('------------------------------------------');
  
  const sensorData = generateSensorData();
  console.log('Sensor reading collected:');
  console.log(`  Voltage R/S/T: ${sensorData.phase_voltage.R}/${sensorData.phase_voltage.S}/${sensorData.phase_voltage.T} V`);
  console.log(`  Current R/S/T: ${sensorData.phase_current.R}/${sensorData.phase_current.S}/${sensorData.phase_current.T} A`);
  console.log(`  Temperature: ${sensorData.temperature} C`);
  
  console.log('\nCreating digital signature...');
  const authData = createAuthenticatedData(DEVICE_ID, privateKey, sensorData);
  console.log(`  Data hash: ${authData.signatureProof.dataHash.substring(0, 32)}...`);
  console.log(`  Nonce: ${authData.signatureProof.nonce.substring(0, 16)}...`);
  console.log(`  Signature: ${authData.signatureProof.signature.substring(0, 32)}...`);
  console.log('Data signed with device private key');
  
  return authData;
}

// Step 3: Verify digital signature
function verifySignature(authData: { data: SensorData; signatureProof: any }): boolean {
  console.log('\nSTEP 3: System - Verify Digital Signature');
  console.log('-----------------------------------------');
  console.log('Verifying with PUBLIC key only (zero-exposure):');
  console.log('  - Checking device registration...');
  console.log('  - Verifying data hash...');
  console.log('  - Checking timestamp...');
  console.log('  - Verifying digital signature...');
  
  const result = verifyAuthenticatedData(authData);
  
  if (result.valid) {
    console.log(`\n[VERIFIED] ${result.reason}`);
    return true;
  } else {
    console.log(`\n[REJECTED] ${result.reason}`);
    return false;
  }
}

// Step 4: Analyze and save data
function analyzeAndSave(data: SensorData): { filename: string; status: any } {
  console.log('\nSTEP 4: Analyze Status & Save');
  console.log('-----------------------------');
  
  const status = analyzeStatus(data);
  printStatus(data, status);
  
  const filename = saveSensorReading(data);
  addToRegistry(filename, data, status.code, status.name);
  
  console.log(`Saved to: data/readings/${filename}`);
  
  return { filename, status };
}

// Step 5: Submit to blockchain
async function submitToBlockchain(
  provider: BlockfrostProvider,
  wallet: MeshWallet,
  data: SensorData,
  status: any,
  recordId: string
): Promise<boolean> {
  console.log('\nSTEP 5: Submit to Cardano Blockchain');
  console.log('-------------------------------------');
  
  const result = await lockData(provider, wallet, data, status);
  
  if (result.success) {
    updateRegistryRecord(recordId, {
      blockchain_hash: hashSensorData(data),
      tx_hash: result.txHash,
      recorded_at: new Date().toISOString(),
    });
    console.log(`\n[SUCCESS] Tx: ${result.txHash}`);
    return true;
  } else {
    console.log(`\n[FAILED] ${result.message}`);
    return false;
  }
}

async function runFullDemo(): Promise<void> {
  printBanner();
  
  console.log('This demo shows the complete flow:');
  console.log('1. Device registration (cryptographic keypair)');
  console.log('2. Sensor data collection & signing');
  console.log('3. Digital signature verification');
  console.log('4. Status analysis & local storage');
  console.log('5. Blockchain submission\n');
  console.log('========================================\n');
  
  // Check blockchain config
  const hasBlockchainConfig = CONFIG.BLOCKFROST_API_KEY && 
    !CONFIG.BLOCKFROST_API_KEY.includes('XXXX') &&
    CONFIG.WALLET_MNEMONIC && 
    !CONFIG.WALLET_MNEMONIC.includes('your twenty four');
  
  // Step 1: Device registration
  const privateKey = ensureDeviceRegistered();
  
  // Step 2: Generate and sign data
  const authData = generateAndSignData(privateKey);
  if (!authData) {
    console.log('Failed to generate authenticated data');
    return;
  }
  
  // Step 3: Verify signature
  const isValid = verifySignature(authData);
  if (!isValid) {
    console.log('\nData rejected - not from legitimate device!');
    return;
  }
  
  // Step 4: Analyze and save
  const { filename, status } = analyzeAndSave(authData.data);
  
  // Step 5: Submit to blockchain (if configured)
  if (hasBlockchainConfig) {
    const plutusJsonPath = path.join(__dirname, '..', '..', 'onchain', 'aiken', 'plutus.json');
    
    if (!fs.existsSync(plutusJsonPath)) {
      console.log('\nBlockchain: plutus.json not found, skipping...');
      console.log('Run: cd ../onchain/aiken && aiken build\n');
    } else {
      const plutusJson = JSON.parse(fs.readFileSync(plutusJsonPath, 'utf-8'));
      const validator = plutusJson.validators.find((v: any) => v.title === 'storage.storage.spend');
      
      if (validator) {
        initContract(validator.compiledCode, CONFIG.NETWORK);
        
        const provider = new BlockfrostProvider(CONFIG.BLOCKFROST_API_KEY);
        const wallet = new MeshWallet({
          networkId: CONFIG.NETWORK === 'mainnet' ? 1 : 0,
          fetcher: provider,
          submitter: provider,
          key: { type: 'mnemonic', words: CONFIG.WALLET_MNEMONIC.split(' ') },
        });
        
        console.log(`\nWallet: ${wallet.getChangeAddress()}`);
        
        // Get registry to find record ID
        const registry = loadRegistry();
        const record = registry.records.find(r => r.filename === filename);
        
        if (record) {
          await submitToBlockchain(provider, wallet, authData.data, status, record.id);
        }
      }
    }
  } else {
    console.log('\nSTEP 5: Blockchain (SKIPPED)');
    console.log('----------------------------');
    console.log('Set BLOCKFROST_API_KEY and WALLET_MNEMONIC in .env');
    console.log('to enable blockchain submission.\n');
  }
  
  // Summary
  console.log('\n========================================');
  console.log('  DEMO COMPLETE');
  console.log('========================================');
  printRegistrySummary();
  
  if (hasBlockchainConfig) {
    console.log(`\nView on explorer:`);
    console.log(`https://${CONFIG.NETWORK}.cardanoscan.io/address/${getScriptAddress()}\n`);
  }
}

// Also support processing existing pending records
async function processPendingRecords(): Promise<void> {
  printBanner();
  console.log('[BATCH MODE] Processing pending records\n');
  
  const hasBlockchainConfig = CONFIG.BLOCKFROST_API_KEY && 
    !CONFIG.BLOCKFROST_API_KEY.includes('XXXX') &&
    CONFIG.WALLET_MNEMONIC && 
    !CONFIG.WALLET_MNEMONIC.includes('your twenty four');
  
  if (!hasBlockchainConfig) {
    console.log('Blockchain not configured. Set .env first.\n');
    return;
  }
  
  const plutusJsonPath = path.join(__dirname, '..', '..', 'onchain', 'aiken', 'plutus.json');
  if (!fs.existsSync(plutusJsonPath)) {
    console.log('plutus.json not found\n');
    return;
  }
  
  const plutusJson = JSON.parse(fs.readFileSync(plutusJsonPath, 'utf-8'));
  const validator = plutusJson.validators.find((v: any) => v.title === 'storage.storage.spend');
  if (!validator) return;
  
  initContract(validator.compiledCode, CONFIG.NETWORK);
  
  const provider = new BlockfrostProvider(CONFIG.BLOCKFROST_API_KEY);
  const wallet = new MeshWallet({
    networkId: CONFIG.NETWORK === 'mainnet' ? 1 : 0,
    fetcher: provider,
    submitter: provider,
    key: { type: 'mnemonic', words: CONFIG.WALLET_MNEMONIC.split(' ') },
  });
  
  console.log(`Wallet: ${wallet.getChangeAddress()}`);
  
  const registry = loadRegistry();
  const pending = registry.records.filter(r => r.tx_hash === null);
  
  console.log(`Pending: ${pending.length} record(s)\n`);
  
  for (let i = 0; i < pending.length; i++) {
    const record = pending[i];
    console.log(`[${i + 1}/${pending.length}] ${record.filename}`);
    
    const data = loadSensorReading(record.filename);
    if (!data) continue;
    
    const status = analyzeStatus(data);
    await submitToBlockchain(provider, wallet, data, status, record.id);
    
    if (i < pending.length - 1) {
      console.log('\nWaiting 30s...\n');
      await sleep(30000);
    }
  }
  
  printRegistrySummary();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.includes('--batch')) {
    await processPendingRecords();
  } else {
    await runFullDemo();
  }
}

main().catch(console.error);
