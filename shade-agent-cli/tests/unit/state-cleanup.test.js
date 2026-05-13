/**
 * Unit tests for src/utils/state-cleanup.js
 *
 * Coverage:
 *  - estimateKeyGas: matches the published storage_remove formula plus the
 *    +30% safety factor for several key/value sizes.
 *  - planBatches:
 *      empty input → no batches.
 *      small entries that all fit in one budget → single batch.
 *      mixed sizes that overflow the budget → boundaries land at the right
 *      indices.
 *      a single oversized entry → it gets its own batch (won't be split
 *      across batches even if it alone exceeds TARGET).
 */
import { describe, it, expect } from "vitest";
import {
  estimateKeyGas,
  planBatches,
} from "../../src/utils/state-cleanup.js";

const STORAGE_REMOVE_BASE = 53_473_030_500n;
const STORAGE_REMOVE_KEY_BYTE = 38_220_384n;
const STORAGE_REMOVE_RET_VALUE_BYTE = 11_531_556n;
const SAFETY = 130n;
const TARGET = 250_000_000_000_000n;

// Build a base64 string whose decoded length is exactly `bytes` bytes.
function b64OfLength(bytes) {
  return Buffer.alloc(bytes, "a").toString("base64");
}

function expectedGas(keyBytes, valueBytes) {
  const raw =
    STORAGE_REMOVE_BASE +
    BigInt(keyBytes) * STORAGE_REMOVE_KEY_BYTE +
    BigInt(valueBytes) * STORAGE_REMOVE_RET_VALUE_BYTE;
  return (raw * SAFETY) / 100n;
}

describe("estimateKeyGas", () => {
  it("matches the formula for a 10-byte key, 100-byte value", () => {
    const got = estimateKeyGas(b64OfLength(10), b64OfLength(100));
    expect(got).toBe(expectedGas(10, 100));
  });

  it("matches the formula for 20-byte key, 3072-byte value", () => {
    const got = estimateKeyGas(b64OfLength(20), b64OfLength(3072));
    expect(got).toBe(expectedGas(20, 3072));
  });

  it("handles empty value", () => {
    const got = estimateKeyGas(b64OfLength(5), b64OfLength(0));
    expect(got).toBe(expectedGas(5, 0));
  });
});

describe("planBatches", () => {
  it("returns no batches for empty input", () => {
    expect(planBatches([])).toEqual([]);
  });

  it("packs small entries into one batch", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      key: b64OfLength(8 + i),
      value: b64OfLength(50),
    }));
    const batches = planBatches(entries);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
  });

  it("splits at the budget boundary for uniform 3 KB-value entries", () => {
    const perKey = expectedGas(20, 3072);
    const perBatch = Number(TARGET / perKey);
    const total = perBatch * 2 + 1;
    const entries = Array.from({ length: total }, () => ({
      key: b64OfLength(20),
      value: b64OfLength(3072),
    }));
    const batches = planBatches(entries);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(perBatch);
    expect(batches[1]).toHaveLength(perBatch);
    expect(batches[2]).toHaveLength(1);
  });

  it("places an oversized single entry in its own batch", () => {
    const entries = [
      { key: b64OfLength(10), value: b64OfLength(50) },
      { key: b64OfLength(10), value: b64OfLength(21_000_000) },
      { key: b64OfLength(10), value: b64OfLength(50) },
    ];
    const batches = planBatches(entries);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(1);
    expect(batches[1]).toHaveLength(1);
    expect(batches[2]).toHaveLength(1);
  });

  it("respects TARGET when packing mixed sizes", () => {
    const entries = [
      { key: b64OfLength(20), value: b64OfLength(500) },
      { key: b64OfLength(20), value: b64OfLength(8_000) },
      { key: b64OfLength(20), value: b64OfLength(800_000) },
      { key: b64OfLength(20), value: b64OfLength(800_000) },
    ];
    const batches = planBatches(entries);
    for (const batch of batches) {
      if (batch.length === 1) continue;
      let sum = 0n;
      for (const _key of batch) {
        sum += (STORAGE_REMOVE_BASE * SAFETY) / 100n;
      }
      expect(sum < TARGET).toBe(true);
    }
    const totalKeys = batches.reduce((n, b) => n + b.length, 0);
    expect(totalKeys).toBe(entries.length);
  });
});
