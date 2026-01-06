// Data manager for sensor readings and registry

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { SensorData } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const READINGS_DIR = path.join(DATA_DIR, 'readings');
const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');

export interface RegistryRecord {
  id: string;
  filename: string;
  device_id: string;
  timestamp: number;
  status_code: number;
  status_name: string;
  blockchain_hash: string | null;
  tx_hash: string | null;
  recorded_at: string | null;
  verified: boolean;
}

export interface Registry {
  records: RegistryRecord[];
  last_updated: string;
}

export function ensureDataDirs(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(READINGS_DIR)) fs.mkdirSync(READINGS_DIR, { recursive: true });
}

export function generateFilename(deviceId: string, timestamp: number): string {
  return `${deviceId}_${timestamp}.json`;
}

export function hashSensorData(data: SensorData): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

export function saveSensorReading(data: SensorData): string {
  ensureDataDirs();
  const timestamp = data.timestamp || Math.floor(Date.now() / 1000);
  const dataWithTimestamp = { ...data, timestamp };
  const filename = generateFilename(data.device_id, timestamp);
  fs.writeFileSync(path.join(READINGS_DIR, filename), JSON.stringify(dataWithTimestamp, null, 2));
  console.log(`Saved: ${filename}`);
  return filename;
}

export function loadSensorReading(filename: string): SensorData | null {
  const filepath = path.join(READINGS_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`Not found: ${filename}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

export function listReadingFiles(): string[] {
  ensureDataDirs();
  if (!fs.existsSync(READINGS_DIR)) return [];
  return fs.readdirSync(READINGS_DIR).filter(f => f.endsWith('.json')).sort();
}

export function loadRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_FILE)) {
    return { records: [], last_updated: new Date().toISOString() };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
}

export function saveRegistry(registry: Registry): void {
  ensureDataDirs();
  registry.last_updated = new Date().toISOString();
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  console.log(`Registry: ${registry.records.length} records`);
}

export function addToRegistry(
  filename: string,
  data: SensorData,
  statusCode: number,
  statusName: string,
  blockchainHash: string | null = null,
  txHash: string | null = null
): RegistryRecord {
  const registry = loadRegistry();
  const newId = `REC-${String(registry.records.length + 1).padStart(3, '0')}`;
  
  const record: RegistryRecord = {
    id: newId,
    filename,
    device_id: data.device_id,
    timestamp: data.timestamp || 0,
    status_code: statusCode,
    status_name: statusName,
    blockchain_hash: blockchainHash,
    tx_hash: txHash,
    recorded_at: txHash ? new Date().toISOString() : null,
    verified: false,
  };
  
  registry.records.push(record);
  saveRegistry(registry);
  return record;
}

export function updateRegistryRecord(id: string, updates: Partial<RegistryRecord>): RegistryRecord | null {
  const registry = loadRegistry();
  const index = registry.records.findIndex(r => r.id === id);
  if (index === -1) return null;
  
  registry.records[index] = { ...registry.records[index], ...updates };
  saveRegistry(registry);
  return registry.records[index];
}

export function findRecordByFilename(filename: string): RegistryRecord | null {
  return loadRegistry().records.find(r => r.filename === filename) || null;
}

export function getUnverifiedRecords(): RegistryRecord[] {
  return loadRegistry().records.filter(r => !r.verified);
}

export function getPendingRecords(): RegistryRecord[] {
  return loadRegistry().records.filter(r => r.tx_hash === null);
}

export function printRegistrySummary(): void {
  const registry = loadRegistry();
  const onChain = registry.records.filter(r => r.tx_hash).length;
  const pending = registry.records.filter(r => !r.tx_hash).length;
  const verified = registry.records.filter(r => r.verified).length;
  
  console.log('\n----------------------------------------');
  console.log('REGISTRY SUMMARY');
  console.log('----------------------------------------');
  console.log(`Total: ${registry.records.length} | On Chain: ${onChain} | Pending: ${pending} | Verified: ${verified}`);
  
  if (registry.records.length > 0) {
    console.log('\nRecords:');
    for (const r of registry.records) {
      const chain = r.tx_hash ? 'Y' : 'N';
      const ver = r.verified ? 'Y' : 'N';
      console.log(`  ${r.id} | ${r.device_id} | ${r.status_name} | Chain:${chain} | Verified:${ver}`);
    }
  }
  console.log('----------------------------------------');
}
