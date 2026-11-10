// `[observer]` in config.toml (OBV-2, OBV-7, OBV-10): defaults, and bad values name the key.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseConfig, reloadObserver } from "../../src/config.ts";
import { tempDir, testConfig } from "../helpers/world.ts";

const base = { intents: { remote: "r" }, github: { app_id: 1, me: "me" } };

test("config: observer settings load and bad values name the key", () => {
  expect(parseConfig(base, "f").observer).toEqual({
    enabled: true,
    dailyAt: "06:00",
    maxProposalsPerWeek: 3,
    dailyBudgetUsd: 3,
    maxBudgetUsd: 1.5,
    bundleKb: 400,
    model: null,
  });
  const set = {
    ...base,
    observer: {
      enabled: false,
      daily_at: "07:45",
      max_proposals_per_week: 2,
      daily_budget_usd: 1,
      max_budget_usd: 0.5,
      bundle_kb: 100,
      model: "sonnet",
    },
  };
  expect(parseConfig(set, "f").observer).toEqual({
    enabled: false,
    dailyAt: "07:45",
    maxProposalsPerWeek: 2,
    dailyBudgetUsd: 1,
    maxBudgetUsd: 0.5,
    bundleKb: 100,
    model: "sonnet",
  });
  const bad: [Record<string, unknown>, string][] = [
    [{ enabled: "yes" }, "observer.enabled must be true or false"],
    [{ daily_at: "6am" }, "observer.daily_at must be a time like 06:00"],
    [{ max_proposals_per_week: 0 }, "observer.max_proposals_per_week must be an integer 1-10"],
    [{ daily_budget_usd: 0 }, "observer.daily_budget_usd must be a number above 0"],
  ];
  for (const [observer, why] of bad) {
    expect(() => parseConfig({ ...base, observer }, "f")).toThrow(`config: f: ${why}`);
  }
});

test("config: the observer keys are read again without a restart", () => {
  const file = join(tempDir(), "config.toml");
  writeFileSync(file, '[observer]\nenabled = false\ndaily_at = "08:15"\n');
  const config = testConfig({}, file);
  expect(config.observer.enabled).toBe(true);
  reloadObserver(config);
  expect(config.observer).toMatchObject({ enabled: false, dailyAt: "08:15" });
  // A bad value keeps what was in force.
  writeFileSync(file, '[observer]\ndaily_at = "never"\n');
  reloadObserver(config);
  expect(config.observer).toMatchObject({ enabled: false, dailyAt: "08:15" });
});
