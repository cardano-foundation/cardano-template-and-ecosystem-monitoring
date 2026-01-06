// Secure Storage - Encrypted key management and replay protection

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const ENCRYPTED_KEYS_FILE = path.join(DATA_DIR, 'device-keys.enc');
const NONCE_FILE = path.join(DATA_DIR, 'used-nonces.json');
const AUTH_TOKENS_FILE = path.join(DATA_DIR, 'auth-tokens.json');

// Encryption config
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;

// Nonce expiry (keep nonces for 10 minutes, then clean up)
const NONCE_EXPIRY_MS = 10 * 60 * 1000;

// Default password for demo (in production, use env variable or secure input)
const DEFAULT_PASSWORD = process.env.DEVICE_KEY_PASSWORD || 'iot-sentinel-demo-2025';

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Derive encryption key from password
function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH);
}

// Encrypt data with AES-256-GCM
export function encryptData(data: string, password: string = DEFAULT_PASSWORD): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);
  
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  
  // Format: salt:iv:authTag:encrypted
  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

// Decrypt data with AES-256-GCM
export function decryptData(encryptedData: string, password: string = DEFAULT_PASSWORD): string | null {
  try {
    const parts = encryptedData.split(':');
    if (parts.length !== 4) return null;
    
    const salt = Buffer.from(parts[0], 'hex');
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = parts[3];
    
    const key = deriveKey(password, salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error('Decryption failed - wrong password or corrupted data');
    return null;
  }
}

// === ENCRYPTED KEY STORAGE ===

interface EncryptedKeyStore {
  version: number;
  encrypted: string;
  created: string;
  lastAccess: string;
}

// Save device keys encrypted
export function saveDeviceKeysSecure(keys: Record<string, string>, password?: string): void {
  ensureDataDir();
  
  const store: EncryptedKeyStore = {
    version: 1,
    encrypted: encryptData(JSON.stringify(keys), password),
    created: new Date().toISOString(),
    lastAccess: new Date().toISOString(),
  };
  
  fs.writeFileSync(ENCRYPTED_KEYS_FILE, JSON.stringify(store, null, 2));
  
  // Remove old plaintext file if exists
  const oldFile = path.join(DATA_DIR, 'device-keys.json');
  if (fs.existsSync(oldFile)) {
    fs.unlinkSync(oldFile);
    console.log('Removed insecure plaintext key file');
  }
}

// Load device keys (decrypted)
export function loadDeviceKeysSecure(password?: string): Record<string, string> | null {
  if (!fs.existsSync(ENCRYPTED_KEYS_FILE)) {
    // Check for old plaintext file and migrate
    const oldFile = path.join(DATA_DIR, 'device-keys.json');
    if (fs.existsSync(oldFile)) {
      console.log('Migrating plaintext keys to encrypted storage...');
      const keys = JSON.parse(fs.readFileSync(oldFile, 'utf-8'));
      saveDeviceKeysSecure(keys, password);
      return keys;
    }
    return {};
  }
  
  const store: EncryptedKeyStore = JSON.parse(fs.readFileSync(ENCRYPTED_KEYS_FILE, 'utf-8'));
  const decrypted = decryptData(store.encrypted, password);
  
  if (!decrypted) return null;
  
  // Update last access
  store.lastAccess = new Date().toISOString();
  fs.writeFileSync(ENCRYPTED_KEYS_FILE, JSON.stringify(store, null, 2));
  
  return JSON.parse(decrypted);
}

// Get single device key
export function getDeviceKeySecure(deviceId: string, password?: string): string | null {
  const keys = loadDeviceKeysSecure(password);
  if (!keys) return null;
  return keys[deviceId] || null;
}

// Save single device key
export function setDeviceKeySecure(deviceId: string, privateKey: string, password?: string): void {
  const keys = loadDeviceKeysSecure(password) || {};
  keys[deviceId] = privateKey;
  saveDeviceKeysSecure(keys, password);
}

// === NONCE STORAGE (Anti-Replay) ===

interface NonceRecord {
  nonce: string;
  deviceId: string;
  timestamp: number;
  usedAt: number;
}

interface NonceStore {
  nonces: NonceRecord[];
  lastCleanup: number;
}

function loadNonceStore(): NonceStore {
  if (!fs.existsSync(NONCE_FILE)) {
    return { nonces: [], lastCleanup: Date.now() };
  }
  return JSON.parse(fs.readFileSync(NONCE_FILE, 'utf-8'));
}

function saveNonceStore(store: NonceStore): void {
  ensureDataDir();
  fs.writeFileSync(NONCE_FILE, JSON.stringify(store, null, 2));
}

// Clean up expired nonces
function cleanupNonces(store: NonceStore): void {
  const now = Date.now();
  if (now - store.lastCleanup < NONCE_EXPIRY_MS) return;
  
  const cutoff = now - NONCE_EXPIRY_MS;
  store.nonces = store.nonces.filter(n => n.usedAt > cutoff);
  store.lastCleanup = now;
}

// Check if nonce was already used (replay attack detection)
export function isNonceUsed(nonce: string, deviceId: string): boolean {
  const store = loadNonceStore();
  cleanupNonces(store);
  
  return store.nonces.some(n => n.nonce === nonce && n.deviceId === deviceId);
}

// Mark nonce as used
export function markNonceUsed(nonce: string, deviceId: string, timestamp: number): void {
  const store = loadNonceStore();
  cleanupNonces(store);
  
  store.nonces.push({
    nonce,
    deviceId,
    timestamp,
    usedAt: Date.now(),
  });
  
  saveNonceStore(store);
}

// === AUTHORIZATION TOKENS (Re-registration Protection) ===

interface AuthToken {
  deviceId: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

interface AuthTokenStore {
  tokens: AuthToken[];
}

function loadAuthTokens(): AuthTokenStore {
  if (!fs.existsSync(AUTH_TOKENS_FILE)) {
    return { tokens: [] };
  }
  return JSON.parse(fs.readFileSync(AUTH_TOKENS_FILE, 'utf-8'));
}

function saveAuthTokens(store: AuthTokenStore): void {
  ensureDataDir();
  fs.writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(store, null, 2));
}

// Generate auth token for device (required for re-registration)
export function generateAuthToken(deviceId: string): string {
  const store = loadAuthTokens();
  
  // Remove existing token for this device
  store.tokens = store.tokens.filter(t => t.deviceId !== deviceId);
  
  // Generate new token (valid for 24 hours)
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  
  store.tokens.push({
    deviceId,
    token,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  });
  
  saveAuthTokens(store);
  return token;
}

// Verify auth token for re-registration
export function verifyAuthToken(deviceId: string, token: string): boolean {
  const store = loadAuthTokens();
  const record = store.tokens.find(t => t.deviceId === deviceId);
  
  if (!record) return false;
  if (record.token !== token) return false;
  if (new Date(record.expiresAt) < new Date()) return false;
  
  return true;
}

// Consume auth token (one-time use)
export function consumeAuthToken(deviceId: string, token: string): boolean {
  if (!verifyAuthToken(deviceId, token)) return false;
  
  const store = loadAuthTokens();
  store.tokens = store.tokens.filter(t => t.deviceId !== deviceId);
  saveAuthTokens(store);
  return true;
}

// Check if device has existing registration
export function hasAuthToken(deviceId: string): boolean {
  const store = loadAuthTokens();
  return store.tokens.some(t => t.deviceId === deviceId);
}

// Print security status
export function printSecurityStatus(): void {
  console.log('\n--- Security Status ---');
  
  const encryptedExists = fs.existsSync(ENCRYPTED_KEYS_FILE);
  const plaintextExists = fs.existsSync(path.join(DATA_DIR, 'device-keys.json'));
  
  console.log(`Encrypted keys: ${encryptedExists ? '[OK]' : '[NOT FOUND]'}`);
  console.log(`Plaintext keys: ${plaintextExists ? '[WARNING] Remove!' : '[OK] None'}`);
  
  const nonceStore = loadNonceStore();
  console.log(`Active nonces: ${nonceStore.nonces.length}`);
  
  const authStore = loadAuthTokens();
  console.log(`Auth tokens: ${authStore.tokens.length}`);
  console.log('-----------------------\n');
}
