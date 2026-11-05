// The default for how much runs at once (LOOP-103): from fake core and memory counts.

import { expect, test } from "vitest";
import { type Capacity, defaultParallel } from "../src/capacity.ts";
import { parseConfig } from "../src/config.ts";

const GIB = 2 ** 30;
const machine = (cores: number, freeGb: number) => (): Capacity => ({ cores, freeBytes: freeGb * GIB });
const parallelOf = (raw: Record<string, unknown>, capacity: () => Capacity) =>
  parseConfig(raw, "/x/config.toml", capacity).agent.parallel;

test("config: parallel defaults from cores and free memory", () => {
  expect(parallelOf({}, machine(8, 16))).toBe(2);
  expect(parallelOf({}, machine(16, 32))).toBe(4);
  expect(parallelOf({}, machine(12, 3))).toBe(2);
  expect(parallelOf({}, machine(12, 100))).toBe(4);
  expect(parallelOf({ agent: {} }, machine(9, 100))).toBe(3);
  // Without a reader (the tests' configs) the default is 1.
  expect(parseConfig({}, "/x/config.toml").agent.parallel).toBe(1);
});

test("config: a set parallel is not replaced", () => {
  expect(parallelOf({ agent: { parallel: 7 } }, machine(2, 1))).toBe(7);
  expect(parallelOf({ agent: { parallel: 1 } }, machine(32, 64))).toBe(1);
});

test("config: parallel is at least 1 and at most 4 by default", () => {
  expect(parallelOf({}, machine(2, 1))).toBe(1);
  expect(parallelOf({}, machine(64, 0.2))).toBe(1);
  expect(parallelOf({}, machine(1, 64))).toBe(1);
  expect(parallelOf({}, machine(128, 512))).toBe(4);
  expect(defaultParallel({ cores: 0, freeBytes: 0 })).toBe(1);
});
