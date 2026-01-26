/**
 * Tests for canonicalization and hashing
 */

import { describe, it, expect } from "vitest";
import { canonicalize, computeHash, hashSnapshot, deriveAssetName } from "./hash.js";
import { generateDailySnapshot } from "./generator.js";

describe("Canonicalization", () => {
  describe("canonicalize", () => {
    it("should sort object keys lexicographically", () => {
      const obj = { z: 1, a: 2, m: 3 };
      const result = canonicalize(obj);
      expect(result).toBe('{"a":2,"m":3,"z":1}');
    });

    it("should sort nested object keys", () => {
      const obj = { b: { z: 1, a: 2 }, a: 1 };
      const result = canonicalize(obj);
      expect(result).toBe('{"a":1,"b":{"a":2,"z":1}}');
    });

    it("should preserve array order", () => {
      const obj = { arr: [3, 1, 2] };
      const result = canonicalize(obj);
      expect(result).toBe('{"arr":[3,1,2]}');
    });

    it("should produce compact JSON without whitespace", () => {
      const obj = { key: "value", nested: { inner: true } };
      const result = canonicalize(obj);
      expect(result).not.toContain(" ");
      expect(result).not.toContain("\n");
    });

    it("should handle null values", () => {
      const obj = { a: null, b: 1 };
      const result = canonicalize(obj);
      expect(result).toBe('{"a":null,"b":1}');
    });

    it("should handle arrays of objects with sorted keys", () => {
      const obj = { items: [{ z: 1, a: 2 }, { b: 3, a: 4 }] };
      const result = canonicalize(obj);
      expect(result).toBe('{"items":[{"a":2,"z":1},{"a":4,"b":3}]}');
    });

    it("should be deterministic", () => {
      const obj = { z: 1, a: 2, m: { x: 1, y: 2 } };
      const result1 = canonicalize(obj);
      const result2 = canonicalize(obj);
      expect(result1).toBe(result2);
    });
  });

  describe("computeHash", () => {
    it("should produce 64-character hex string", () => {
      const hash = computeHash("test data");
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it("should produce consistent hash for same input", () => {
      const hash1 = computeHash("test data");
      const hash2 = computeHash("test data");
      expect(hash1).toBe(hash2);
    });

    it("should produce different hash for different input", () => {
      const hash1 = computeHash("test data 1");
      const hash2 = computeHash("test data 2");
      expect(hash1).not.toBe(hash2);
    });

    it("should match known SHA-256 hash", () => {
      // Known SHA-256 hash of "hello"
      const hash = computeHash("hello");
      expect(hash).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
      );
    });
  });

  describe("hashSnapshot", () => {
    it("should produce consistent hash for same snapshot", () => {
      const snapshot1 = generateDailySnapshot("2025-12-19", 42);
      const snapshot2 = generateDailySnapshot("2025-12-19", 42);

      const hash1 = hashSnapshot(snapshot1);
      const hash2 = hashSnapshot(snapshot2);

      expect(hash1.commitmentHash).toBe(hash2.commitmentHash);
    });

    it("should produce different hash for different snapshots", () => {
      const snapshot1 = generateDailySnapshot("2025-12-19", 42);
      const snapshot2 = generateDailySnapshot("2025-12-19", 43);

      const hash1 = hashSnapshot(snapshot1);
      const hash2 = hashSnapshot(snapshot2);

      expect(hash1.commitmentHash).not.toBe(hash2.commitmentHash);
    });

    it("should return correct metadata", () => {
      const snapshot = generateDailySnapshot("2025-12-19", 42);
      const hash = hashSnapshot(snapshot);

      expect(hash.snapshotId).toBe("2025-12-19");
      expect(hash.snapshotType).toBe("daily");
      expect(hash.recordCount).toBe(snapshot.records.length);
      expect(hash.canonicalJsonLength).toBeGreaterThan(0);
    });
  });

  describe("deriveAssetName", () => {
    it("should produce 64-character hex string", () => {
      const assetName = deriveAssetName("2025-12-19");
      expect(assetName).toHaveLength(64);
      expect(assetName).toMatch(/^[0-9a-f]+$/);
    });

    it("should produce consistent output for same input", () => {
      const name1 = deriveAssetName("2025-12-19");
      const name2 = deriveAssetName("2025-12-19");
      expect(name1).toBe(name2);
    });

    it("should produce different output for different inputs", () => {
      const name1 = deriveAssetName("2025-12-19");
      const name2 = deriveAssetName("2025-12-20");
      expect(name1).not.toBe(name2);
    });
  });
});
