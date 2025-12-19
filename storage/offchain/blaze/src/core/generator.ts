/**
 * Deterministic Snapshot Generator
 *
 * Generates reproducible audit snapshot datasets based on seed and snapshotId.
 * Given the same inputs, always produces the same output.
 */

import { SeededRandom, combineSeed } from "./random.js";
import type { Snapshot, SnapshotRecord, SnapshotType, Direction } from "../types/index.js";

// Sample data for generating realistic-looking records
const ACCOUNTS = [
  "cash",
  "accounts-receivable",
  "accounts-payable",
  "inventory",
  "revenue",
  "expenses",
  "equity",
  "loans-payable",
  "prepaid-expenses",
  "accrued-liabilities",
];

const COUNTERPARTIES = [
  "Acme Corp",
  "Global Trading Co",
  "Tech Solutions Ltd",
  "Prime Suppliers Inc",
  "Metro Services",
  "United Logistics",
  "Alpha Manufacturing",
  "Beta Retail Group",
  "Gamma Consulting",
  "Delta Financial",
];

const DESCRIPTIONS = [
  "Payment received",
  "Invoice issued",
  "Supplier payment",
  "Salary expense",
  "Utility bill",
  "Equipment purchase",
  "Service fee",
  "Interest payment",
  "Tax payment",
  "Refund processed",
  "Deposit received",
  "Commission paid",
  "Rent expense",
  "Insurance premium",
  "Maintenance cost",
];

/**
 * Parse and validate a daily snapshot ID (YYYY-MM-DD)
 */
function parseDailyId(snapshotId: string): Date {
  const regex = /^(\d{4})-(\d{2})-(\d{2})$/;
  const match = snapshotId.match(regex);
  if (!match) {
    throw new Error(`Invalid daily snapshotId format: ${snapshotId}. Expected YYYY-MM-DD`);
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  const day = parseInt(dayStr);
  
  // Validate month range
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}`);
  }
  
  // Validate day range
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    throw new Error(`Invalid day: ${day} for month ${month}`);
  }
  
  const date = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${snapshotId}`);
  }
  return date;
}

/**
 * Parse and validate a monthly snapshot ID (YYYY-MM)
 */
function parseMonthlyId(snapshotId: string): { year: number; month: number } {
  const regex = /^(\d{4})-(\d{2})$/;
  const match = snapshotId.match(regex);
  if (!match) {
    throw new Error(`Invalid monthly snapshotId format: ${snapshotId}. Expected YYYY-MM`);
  }
  const year = parseInt(match[1]);
  const month = parseInt(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}`);
  }
  return { year, month };
}

/**
 * Get all days in a month
 */
function getDaysInMonth(year: number, month: number): string[] {
  const days: string[] = [];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= daysInMonth; day++) {
    const dayStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    days.push(dayStr);
  }
  return days;
}

/**
 * Generate a single record deterministically
 */
function generateRecord(rng: SeededRandom, date: Date, index: number): SnapshotRecord {
  // Generate timestamp within the day with deterministic hours/minutes
  const hour = rng.nextInt(8, 18); // Business hours
  const minute = rng.nextInt(0, 60);
  const second = rng.nextInt(0, 60);

  const timestamp = new Date(date);
  timestamp.setUTCHours(hour, minute, second, 0);

  const direction: Direction = rng.next() > 0.5 ? "credit" : "debit";

  // Generate amount with 2 decimal places
  const amount = Math.round(rng.nextFloat(10, 10000) * 100) / 100;

  return {
    id: rng.nextId("txn-"),
    timestamp: timestamp.toISOString(),
    description: rng.pick(DESCRIPTIONS),
    amount,
    direction,
    account: rng.pick(ACCOUNTS),
    counterparty: rng.pick(COUNTERPARTIES),
  };
}

/**
 * Sort records deterministically by timestamp, then by id
 */
function sortRecords(records: SnapshotRecord[]): SnapshotRecord[] {
  return [...records].sort((a, b) => {
    const timeCompare = a.timestamp.localeCompare(b.timestamp);
    if (timeCompare !== 0) return timeCompare;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Generate a daily snapshot (10-50 records for a single day)
 */
export function generateDailySnapshot(snapshotId: string, seed: number): Snapshot {
  const date = parseDailyId(snapshotId);

  // Combine snapshotId and seed for deterministic generation
  const combinedSeed = combineSeed(snapshotId, seed, "daily");
  const rng = new SeededRandom(combinedSeed);

  // Generate 10-50 records
  const recordCount = rng.nextInt(10, 51);
  const records: SnapshotRecord[] = [];

  for (let i = 0; i < recordCount; i++) {
    records.push(generateRecord(rng, date, i));
  }

  // Sort deterministically
  const sortedRecords = sortRecords(records);

  return {
    snapshotId,
    snapshotType: "daily",
    seed,
    generatedAt: new Date().toISOString(),
    records: sortedRecords,
  };
}

/**
 * Generate a monthly snapshot (aggregation of all daily snapshots in the month)
 */
export function generateMonthlySnapshot(snapshotId: string, seed: number): Snapshot {
  const { year, month } = parseMonthlyId(snapshotId);
  const days = getDaysInMonth(year, month);

  // Aggregate all daily records
  const allRecords: SnapshotRecord[] = [];

  for (const dayId of days) {
    const dailySnapshot = generateDailySnapshot(dayId, seed);
    allRecords.push(...dailySnapshot.records);
  }

  // Sort all records deterministically
  const sortedRecords = sortRecords(allRecords);

  return {
    snapshotId,
    snapshotType: "monthly",
    seed,
    generatedAt: new Date().toISOString(),
    records: sortedRecords,
  };
}

/**
 * Generate snapshot based on type
 */
export function generateSnapshot(
  snapshotId: string,
  snapshotType: SnapshotType,
  seed: number
): Snapshot {
  if (snapshotType === "daily") {
    return generateDailySnapshot(snapshotId, seed);
  } else {
    return generateMonthlySnapshot(snapshotId, seed);
  }
}
