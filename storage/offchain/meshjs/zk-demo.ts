// IoT Sentinel - Zero Knowledge Authentication Demo
// Demonstrates how ZK proofs ensure data comes from legitimate IoT devices

import { 
  registerDevice, 
  createAuthenticatedData, 
  verifyAuthenticatedData,
  verifyZKProof,
  createZKProof,
  printDeviceRegistry,
  loadDeviceRegistry,
  isDeviceRegistered
} from './lib/zk-auth';
import { SensorData } from './lib/types';
import { analyzeStatus, printStatus } from './lib/analyzer';
import { saveSensorReading, addToRegistry, hashSensorData, printRegistrySummary } from './lib/data-manager';
import {
  getDeviceKeySecure, setDeviceKeySecure, loadDeviceKeysSecure, saveDeviceKeysSecure,
  printSecurityStatus,
} from './lib/secure-storage';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load device private keys (now encrypted)
function loadDeviceKeys(): Record<string, string> {
  return loadDeviceKeysSecure() || {};
}

// Save device private keys (now encrypted)
function saveDeviceKeys(keys: Record<string, string>): void {
  saveDeviceKeysSecure(keys);
}

// Generate sample sensor data
function generateSensorData(deviceId: string): SensorData {
  const rand = (base: number, range: number) => 
    Math.round((base + (Math.random() - 0.5) * range * 2) * 10) / 10;
  
  return {
    device_id: deviceId,
    phase_voltage: { R: rand(220, 2), S: rand(219, 2), T: rand(221, 2) },
    phase_current: { R: rand(50, 5), S: rand(49, 5), T: rand(51, 5) },
    temperature: rand(65, 5),
    inom_setting: 100,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

async function main(): Promise<void> {
  console.log('\n========================================');
  console.log('  IoT SENTINEL - ZK Authentication Demo');
  console.log('========================================\n');

  const args = process.argv.slice(2);
  
  // Demo mode selection
  if (args.includes('--register')) {
    await demoRegisterDevice();
  } else if (args.includes('--send')) {
    await demoSendData();
  } else if (args.includes('--fake')) {
    await demoFakeDevice();
  } else if (args.includes('--tamper')) {
    await demoTamperedData();
  } else {
    await demoFull();
  }
}

// Demo 1: Register a new IoT device
async function demoRegisterDevice(): Promise<void> {
  console.log('[DEMO] Registering new IoT device\n');
  
  const deviceId = 'TRAFO-SINJAI-01';
  
  // Register device and get keypair
  const { privateKey, publicKey } = registerDevice(deviceId, '3-Phase Transformer Sinjai');
  
  // Store private key (in real world, this stays on device!)
  const keys = loadDeviceKeys();
  keys[deviceId] = privateKey;
  saveDeviceKeys(keys);
  
  console.log('\nKey generation complete!');
  console.log('- Public key: Stored in system (data/devices.json)');
  console.log('- Private key: Stored on device (data/device-keys.json)');
  console.log('\nIn production:');
  console.log('- Private key NEVER leaves the IoT device');
  console.log('- System only knows public key');
  
  printDeviceRegistry();
}

// Demo 2: Send authenticated data from legitimate device
async function demoSendData(): Promise<void> {
  console.log('[DEMO] Sending authenticated data from IoT device\n');
  
  const deviceId = 'TRAFO-SINJAI-01';
  
  // Check device is registered
  if (!isDeviceRegistered(deviceId)) {
    console.log(`Device ${deviceId} not registered. Run: npm run zk:register`);
    return;
  }
  
  // Load device private key (on real device, this is stored securely)
  const keys = loadDeviceKeys();
  const privateKey = keys[deviceId];
  
  if (!privateKey) {
    console.log('Private key not found. Run: npm run zk:register');
    return;
  }
  
  console.log('=== IoT DEVICE SIDE ===\n');
  
  // Generate sensor data
  const sensorData = generateSensorData(deviceId);
  console.log('1. Sensor reading collected:');
  console.log(`   Temperature: ${sensorData.temperature} C`);
  console.log(`   Voltage R/S/T: ${sensorData.phase_voltage.R}/${sensorData.phase_voltage.S}/${sensorData.phase_voltage.T} V`);
  
  // Create ZK proof
  console.log('\n2. Creating ZK proof...');
  const authData = createAuthenticatedData(deviceId, privateKey, sensorData);
  console.log(`   Data hash: ${authData.zkProof.dataHash.substring(0, 32)}...`);
  console.log(`   Nonce: ${authData.zkProof.nonce}`);
  console.log(`   Signature: ${authData.zkProof.signature.substring(0, 32)}...`);
  
  console.log('\n3. Sending to system...');
  console.log('   [Data + ZK Proof transmitted]\n');
  
  console.log('=== SYSTEM/VALIDATOR SIDE ===\n');
  
  // Verify ZK proof
  console.log('4. Verifying ZK proof...');
  console.log('   - Checking device registration');
  console.log('   - Verifying data hash');
  console.log('   - Checking timestamp');
  console.log('   - Verifying signature (using PUBLIC key only!)');
  
  const result = verifyAuthenticatedData(authData);
  
  console.log(`\n5. Verification result: ${result.valid ? '[VALID]' : '[INVALID]'}`);
  console.log(`   ${result.reason}`);
  
  if (result.valid) {
    console.log('\n6. Processing sensor data...');
    const status = analyzeStatus(sensorData);
    printStatus(sensorData, status);
    
    // Save to file
    const filename = saveSensorReading(sensorData);
    const hash = hashSensorData(sensorData);
    addToRegistry(filename, sensorData, status.code, status.name);
    
    console.log(`\nData accepted and saved: ${filename}`);
  }
}

// Demo 3: Fake device trying to send data
async function demoFakeDevice(): Promise<void> {
  console.log('[DEMO] Fake device attempting to send data\n');
  console.log('Scenario: Attacker tries to inject fake sensor data\n');
  
  console.log('=== ATTACKER SIDE ===\n');
  
  // Attacker creates fake data
  const fakeData: SensorData = {
    device_id: 'TRAFO-SINJAI-01',  // Pretending to be legitimate device
    phase_voltage: { R: 220, S: 220, T: 220 },
    phase_current: { R: 30, S: 30, T: 30 },  // Hiding real overload!
    temperature: 50,  // Hiding real high temp!
    inom_setting: 100,
    timestamp: Math.floor(Date.now() / 1000),
  };
  
  console.log('1. Attacker creates fake "normal" data to hide real issues');
  console.log(`   Fake temperature: ${fakeData.temperature} C (real might be 85 C)`);
  console.log(`   Fake current: ${fakeData.phase_current.R} A (real might be 110 A)`);
  
  // Attacker tries to create fake proof with random signature
  console.log('\n2. Attacker creates fake ZK proof...');
  const fakeProof = {
    deviceId: 'TRAFO-SINJAI-01',
    dataHash: require('crypto').createHash('sha256').update(JSON.stringify(fakeData)).digest('hex'),
    nonce: require('crypto').randomBytes(16).toString('hex'),
    timestamp: Math.floor(Date.now() / 1000),
    signature: require('crypto').randomBytes(64).toString('base64'), // FAKE signature!
  };
  
  console.log(`   Fake signature: ${fakeProof.signature.substring(0, 32)}...`);
  
  console.log('\n3. Attacker sends fake data to system...\n');
  
  console.log('=== SYSTEM/VALIDATOR SIDE ===\n');
  
  console.log('4. Verifying ZK proof...');
  
  const result = verifyZKProof(fakeProof, fakeData);
  
  console.log(`\n5. Verification result: ${result.valid ? '[VALID]' : '[REJECTED]'}`);
  console.log(`   ${result.reason}`);
  
  console.log('\n========================================');
  console.log('ATTACK FAILED!');
  console.log('Without the private key, attacker cannot');
  console.log('create valid signature. Data rejected.');
  console.log('========================================\n');
}

// Demo 4: Legitimate device but data tampered in transit
async function demoTamperedData(): Promise<void> {
  console.log('[DEMO] Data tampered during transmission\n');
  console.log('Scenario: Man-in-the-middle modifies data after device signs it\n');
  
  const deviceId = 'TRAFO-SINJAI-01';
  
  if (!isDeviceRegistered(deviceId)) {
    console.log(`Device ${deviceId} not registered. Run: npm run zk:register`);
    return;
  }
  
  const keys = loadDeviceKeys();
  const privateKey = keys[deviceId];
  
  if (!privateKey) {
    console.log('Private key not found. Run: npm run zk:register');
    return;
  }
  
  console.log('=== IoT DEVICE SIDE ===\n');
  
  // Original data from device
  const originalData: SensorData = {
    device_id: deviceId,
    phase_voltage: { R: 218, S: 217, T: 219 },
    phase_current: { R: 110, S: 108, T: 112 },  // OVERLOAD!
    temperature: 85,  // HIGH TEMP!
    inom_setting: 100,
    timestamp: Math.floor(Date.now() / 1000),
  };
  
  console.log('1. Device sends REAL data (showing problems):');
  console.log(`   Temperature: ${originalData.temperature} C (HIGH!)}`);
  console.log(`   Current R: ${originalData.phase_current.R} A (OVERLOAD!)`);
  
  // Device creates valid proof
  const authData = createAuthenticatedData(deviceId, privateKey, originalData);
  console.log('\n2. Device creates valid ZK proof and sends...');
  
  console.log('\n=== MAN-IN-THE-MIDDLE ATTACK ===\n');
  
  // Attacker intercepts and modifies data
  const tamperedData: SensorData = {
    ...originalData,
    phase_current: { R: 50, S: 49, T: 51 },  // Changed to hide overload
    temperature: 65,  // Changed to hide high temp
  };
  
  console.log('3. Attacker intercepts and modifies data:');
  console.log(`   Temperature: ${originalData.temperature} -> ${tamperedData.temperature} C`);
  console.log(`   Current R: ${originalData.phase_current.R} -> ${tamperedData.phase_current.R} A`);
  
  // Attacker sends tampered data with original proof
  console.log('\n4. Attacker sends TAMPERED data with ORIGINAL proof...\n');
  
  console.log('=== SYSTEM/VALIDATOR SIDE ===\n');
  
  console.log('5. Verifying ZK proof against received data...');
  
  // System verifies - will fail because data doesn't match proof!
  const result = verifyZKProof(authData.zkProof, tamperedData);
  
  console.log(`\n6. Verification result: ${result.valid ? '[VALID]' : '[REJECTED]'}`);
  console.log(`   ${result.reason}`);
  
  console.log('\n========================================');
  console.log('TAMPERING DETECTED!');
  console.log('The ZK proof was for original data.');
  console.log('Modified data produces different hash.');
  console.log('System rejects the tampered data.');
  console.log('========================================\n');
}

// Full demo showing all scenarios
async function demoFull(): Promise<void> {
  console.log('Zero-Knowledge Authentication Flow:\n');
  console.log('1. IoT device has PRIVATE key (secret, never shared)');
  console.log('2. System stores PUBLIC key (can verify signatures)');
  console.log('3. Device signs data with private key');
  console.log('4. System verifies signature with public key');
  console.log('5. System accepts data ONLY if signature valid\n');
  
  console.log('This is "Zero-Knowledge" because:');
  console.log('- System never knows the private key');
  console.log('- Yet can verify data came from legitimate device\n');
  
  console.log('Available demos:\n');
  console.log('  npm run zk:register  - Register new IoT device');
  console.log('  npm run zk:send      - Send authenticated data');
  console.log('  npm run zk:fake      - Fake device attack (will fail)');
  console.log('  npm run zk:tamper    - Data tampering attack (will fail)\n');
  
  printDeviceRegistry();
}

main().catch(console.error);
