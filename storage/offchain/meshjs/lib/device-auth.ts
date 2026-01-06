// Cryptographic Device Authentication (Zero-Exposure)
// Ensures data comes from legitimate IoT device without exposing the private key

import { generateKeyPairSync, sign, verify, createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  isNonceUsed, markNonceUsed,
  generateAuthToken, verifyAuthToken, consumeAuthToken,
} from './secure-storage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEVICES_FILE = path.join(__dirname, '..', 'data', 'devices.json');

// Security config
const TIMESTAMP_WINDOW_SECONDS = 60;  // Reduced from 300 to 60 seconds
const ENABLE_NONCE_CHECK = true;      // Enable replay attack protection

// Device credentials (private key stays on device, public key registered in system)
export interface DeviceRegistration {
  deviceId: string;
  publicKey: string;       // Stored in system (can verify signatures)
  registeredAt: string;
  description: string;
}

// Digital signature proof attached to each sensor reading
export interface SignatureProof {
  deviceId: string;
  dataHash: string;        // Hash of sensor data
  nonce: string;           // Random value to prevent replay attacks
  timestamp: number;       // When proof was created
  signature: string;       // Digital signature (proves device has private key)
}

// Sensor data with signature proof attached
export interface AuthenticatedSensorData {
  data: any;
  signatureProof: SignatureProof;
}

// Device registry
interface DeviceRegistry {
  devices: DeviceRegistration[];
  lastUpdated: string;
}

// Load device registry
export function loadDeviceRegistry(): DeviceRegistry {
  if (!fs.existsSync(DEVICES_FILE)) {
    return { devices: [], lastUpdated: new Date().toISOString() };
  }
  return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf-8'));
}

// Save device registry
function saveDeviceRegistry(registry: DeviceRegistry): void {
  const dir = path.dirname(DEVICES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  registry.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(registry, null, 2));
}

// Register new IoT device (returns private key - device must store securely!)
// authToken is required when re-registering an existing device
export function registerDevice(
  deviceId: string, 
  description: string = '',
  authToken?: string
): { 
  deviceId: string; 
  privateKey: string; 
  publicKey: string;
  reRegistrationToken?: string;
} {
  const registry = loadDeviceRegistry();
  const existingDevice = registry.devices.find(d => d.deviceId === deviceId);
  
  // Security: Require auth token for re-registration
  if (existingDevice) {
    if (!authToken) {
      throw new Error(
        `Device ${deviceId} already registered. ` +
        `To re-register, generate auth token first with generateReRegistrationToken()`
      );
    }
    if (!consumeAuthToken(deviceId, authToken)) {
      throw new Error('Invalid or expired auth token for re-registration');
    }
    console.log(`Re-registration authorized for ${deviceId}`);
    registry.devices = registry.devices.filter(d => d.deviceId !== deviceId);
  }
  
  // Generate Ed25519 keypair
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  
  registry.devices.push({
    deviceId,
    publicKey,
    registeredAt: new Date().toISOString(),
    description
  });
  
  saveDeviceRegistry(registry);
  
  // Generate re-registration token for future use
  const reRegistrationToken = generateAuthToken(deviceId);
  
  console.log(`Device registered: ${deviceId}`);
  console.log(`Public key stored in system`);
  console.log(`IMPORTANT: Private key must be stored securely on IoT device!`);
  console.log(`Re-registration token generated (save for future key rotation)`);
  
  return { deviceId, privateKey, publicKey, reRegistrationToken };
}

// Get device public key
export function getDevicePublicKey(deviceId: string): string | null {
  const registry = loadDeviceRegistry();
  const device = registry.devices.find(d => d.deviceId === deviceId);
  return device?.publicKey || null;
}

// Check if device is registered
export function isDeviceRegistered(deviceId: string): boolean {
  return getDevicePublicKey(deviceId) !== null;
}

// === IoT DEVICE SIDE ===
// These functions run on the IoT device

// Create digital signature proof for sensor data (runs on IoT device)
export function createSignatureProof(
  deviceId: string,
  privateKey: string,
  sensorData: any
): SignatureProof {
  // Hash the sensor data
  const dataHash = createHash('sha256')
    .update(JSON.stringify(sensorData))
    .digest('hex');
  
  // Generate nonce (prevents replay attacks)
  const nonce = randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  
  // Create message to sign: dataHash + nonce + timestamp
  const message = `${dataHash}:${nonce}:${timestamp}`;
  
  // Sign with private key (proves we have the key without exposing it)
  const signature = sign(
    null,
    Buffer.from(message),
    privateKey
  ).toString('base64');
  
  return {
    deviceId,
    dataHash,
    nonce,
    timestamp,
    signature
  };
}

// Create authenticated sensor data package
export function createAuthenticatedData(
  deviceId: string,
  privateKey: string,
  sensorData: any
): AuthenticatedSensorData {
  const signatureProof = createSignatureProof(deviceId, privateKey, sensorData);
  return { data: sensorData, signatureProof };
}

// === SYSTEM/VALIDATOR SIDE ===
// These functions run on the receiving system

// Verify digital signature (without knowing private key - zero exposure)
export function verifySignatureProof(proof: SignatureProof, sensorData: any): {
  valid: boolean;
  reason: string;
} {
  // Check device is registered
  const publicKey = getDevicePublicKey(proof.deviceId);
  if (!publicKey) {
    return { valid: false, reason: 'Device not registered' };
  }
  
  // Verify data hash matches
  const computedHash = createHash('sha256')
    .update(JSON.stringify(sensorData))
    .digest('hex');
  
  if (computedHash !== proof.dataHash) {
    return { valid: false, reason: 'Data hash mismatch - data may be tampered' };
  }
  
  // Check timestamp is reasonable (reduced window for security)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - proof.timestamp) > TIMESTAMP_WINDOW_SECONDS) {
    return { valid: false, reason: `Proof expired (>${TIMESTAMP_WINDOW_SECONDS}s) or timestamp invalid` };
  }
  
  // Anti-replay: Check if nonce was already used
  if (ENABLE_NONCE_CHECK) {
    if (isNonceUsed(proof.nonce, proof.deviceId)) {
      return { valid: false, reason: 'Replay attack detected - nonce already used' };
    }
  }
  
  // Recreate the signed message
  const message = `${proof.dataHash}:${proof.nonce}:${proof.timestamp}`;
  
  // Verify signature using public key (zero-exposure: we don't know private key)
  try {
    const isValid = verify(
      null,
      Buffer.from(message),
      publicKey,
      Buffer.from(proof.signature, 'base64')
    );
    
    if (!isValid) {
      return { valid: false, reason: 'Invalid signature - not from registered device' };
    }
    
    // Mark nonce as used (prevent replay)
    if (ENABLE_NONCE_CHECK) {
      markNonceUsed(proof.nonce, proof.deviceId, proof.timestamp);
    }
    
    return { valid: true, reason: 'Signature verified - data is from legitimate IoT device' };
  } catch (error) {
    return { valid: false, reason: `Signature verification failed: ${error}` };
  }
}

// Verify authenticated data package
export function verifyAuthenticatedData(authData: AuthenticatedSensorData): {
  valid: boolean;
  reason: string;
} {
  return verifySignatureProof(authData.signatureProof, authData.data);
}

// Generate re-registration token (required before re-registering)
export function generateReRegistrationToken(deviceId: string): string {
  if (!isDeviceRegistered(deviceId)) {
    throw new Error(`Device ${deviceId} not registered`);
  }
  const token = generateAuthToken(deviceId);
  console.log(`Re-registration token generated for ${deviceId}`);
  console.log(`Token valid for 24 hours`);
  return token;
}

// Print device registry
export function printDeviceRegistry(): void {
  const registry = loadDeviceRegistry();
  
  console.log('\n----------------------------------------');
  console.log('REGISTERED IoT DEVICES');
  console.log('----------------------------------------');
  console.log(`Total: ${registry.devices.length} device(s)\n`);
  console.log(`Security: Timestamp window = ${TIMESTAMP_WINDOW_SECONDS}s`);
  console.log(`Security: Nonce check = ${ENABLE_NONCE_CHECK ? 'ENABLED' : 'DISABLED'}\n`);
  
  for (const device of registry.devices) {
    console.log(`  ${device.deviceId}`);
    console.log(`    Registered: ${device.registeredAt}`);
    console.log(`    Description: ${device.description || '-'}`);
    console.log(`    Public Key: ${device.publicKey.substring(27, 70)}...`);
  }
  console.log('----------------------------------------');
}
