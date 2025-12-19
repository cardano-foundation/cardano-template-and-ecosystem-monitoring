/**
 * Tests for deterministic snapshot generator
 */

import { describe, it, expect } from "vitest";
import { generateDailySnapshot, generateMonthlySnapshot } from "./generator.js";

describe("Deterministic Generator", () => {
  describe("generateDailySnapshot", () => {
    it("should generate deterministic output for same inputs", () => {
      const snapshot1 = generateDailySnapshot("2025-12-19", 42);
      const snapshot2 = generateDailySnapshot("2025-12-19", 42);

      // Remove generatedAt as it's timestamp-based
      const records1 = snapshot1.records;
      const records2 = snapshot2.records;

      expect(records1).toEqual(records2);
      expect(snapshot1.snapshotId).toBe(snapshot2.snapshotId);
      expect(snapshot1.snapshotType).toBe(snapshot2.snapshotType);
      expect(snapshot1.seed).toBe(snapshot2.seed);
    });

    it("should generate different output for different seeds", () => {
      const snapshot1 = generateDailySnapshot("2025-12-19", 42);
      const snapshot2 = generateDailySnapshot("2025-12-19", 43);

      expect(snapshot1.records).not.toEqual(snapshot2.records);
    });

    it("should generate different output for different dates", () => {
      const snapshot1 = generateDailySnapshot("2025-12-19", 42);
      const snapshot2 = generateDailySnapshot("2025-12-20", 42);

      expect(snapshot1.records).not.toEqual(snapshot2.records);
    });

    it("should generate 10-50 records", () => {
      const snapshot = generateDailySnapshot("2025-12-19", 42);
      expect(snapshot.records.length).toBeGreaterThanOrEqual(10);
      expect(snapshot.records.length).toBeLessThanOrEqual(50);
    });

    it("should have records sorted by timestamp then id", () => {
      const snapshot = generateDailySnapshot("2025-12-19", 42);
      const records = snapshot.records;

      for (let i = 1; i < records.length; i++) {
        const prev = records[i - 1];
        const curr = records[i];
        const timeCompare = prev.timestamp.localeCompare(curr.timestamp);
        if (timeCompare === 0) {
          expect(prev.id.localeCompare(curr.id)).toBeLessThanOrEqual(0);
        } else {
          expect(timeCompare).toBeLessThan(0);
        }
      }
    });

    it("should have valid record structure", () => {
      const snapshot = generateDailySnapshot("2025-12-19", 42);
      const record = snapshot.records[0];

      expect(record).toHaveProperty("id");
      expect(record).toHaveProperty("timestamp");
      expect(record).toHaveProperty("description");
      expect(record).toHaveProperty("amount");
      expect(record).toHaveProperty("direction");
      expect(record).toHaveProperty("account");
      expect(record).toHaveProperty("counterparty");

      expect(typeof record.id).toBe("string");
      expect(typeof record.timestamp).toBe("string");
      expect(typeof record.amount).toBe("number");
      expect(["debit", "credit"]).toContain(record.direction);
    });

    it("should reject invalid date format", () => {
      expect(() => generateDailySnapshot("2025-13-01", 42)).toThrow();
      expect(() => generateDailySnapshot("2025/12/19", 42)).toThrow();
      expect(() => generateDailySnapshot("invalid", 42)).toThrow();
    });
  });

  describe("generateMonthlySnapshot", () => {
    it("should generate deterministic output for same inputs", () => {
      const snapshot1 = generateMonthlySnapshot("2025-02", 42);
      const snapshot2 = generateMonthlySnapshot("2025-02", 42);

      expect(snapshot1.records).toEqual(snapshot2.records);
    });

    it("should aggregate all days in the month", () => {
      const monthly = generateMonthlySnapshot("2025-02", 42);
      
      // February 2025 has 28 days
      // Each day generates 10-50 records
      // So minimum is 28 * 10 = 280, maximum is 28 * 50 = 1400
      expect(monthly.records.length).toBeGreaterThanOrEqual(280);
      expect(monthly.records.length).toBeLessThanOrEqual(1400);
    });

    it("should have records from all days in the month", () => {
      const monthly = generateMonthlySnapshot("2025-02", 42);
      
      // Get unique dates from timestamps
      const dates = new Set(
        monthly.records.map((r) => r.timestamp.substring(0, 10))
      );

      // Should have records from all 28 days
      expect(dates.size).toBe(28);
    });

    it("should reject invalid month format", () => {
      expect(() => generateMonthlySnapshot("2025-13", 42)).toThrow();
      expect(() => generateMonthlySnapshot("2025/12", 42)).toThrow();
      expect(() => generateMonthlySnapshot("invalid", 42)).toThrow();
    });
  });
});
