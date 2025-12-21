/**
 * Deterministic Pseudo-Random Number Generator (PRNG)
 *
 * Uses a seeded Mulberry32 algorithm for reproducible random generation.
 * Given the same seed, it will always produce the same sequence of numbers.
 */

/**
 * Mulberry32 - A fast, high-quality 32-bit PRNG
 * @see https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // Ensure seed is a 32-bit integer
    this.state = seed >>> 0;
  }

  /**
   * Get next random number between 0 and 1
   */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Get random integer between min (inclusive) and max (exclusive)
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min)) + min;
  }

  /**
   * Get random float between min and max
   */
  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  /**
   * Pick random item from array
   */
  pick<T>(items: T[]): T {
    return items[this.nextInt(0, items.length)];
  }

  /**
   * Generate random string ID
   */
  nextId(prefix: string, length: number = 8): string {
    const chars = "0123456789abcdef";
    let result = prefix;
    for (let i = 0; i < length; i++) {
      result += chars[this.nextInt(0, chars.length)];
    }
    return result;
  }
}

/**
 * Create a hash from a string to use as seed
 * Uses djb2 algorithm for string hashing
 */
export function stringToSeed(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

/**
 * Combine multiple values into a single seed
 */
export function combineSeed(...values: (string | number)[]): number {
  return stringToSeed(values.map(String).join("|"));
}
