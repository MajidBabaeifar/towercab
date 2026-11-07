// MET-31: an amount the page saves is one the config loads back at the next start.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MAX_BUDGET, raiseTo, saveBudgets } from "../src/budgets.ts";
import { loadConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { tempDir } from "./helpers/world.ts";

const FILE = `[intents]
remote = "https://github.com/me/intents.git"

[github]
app_id = 7
me = "me"

[repos.web]
github = "me/web"
`;

test("metrics: a budget saved from the page loads back through loadConfig", () => {
  const file = join(tempDir("tc-budget-load-"), "config.toml");
  writeFileSync(file, FILE);
  const config = loadConfig(file);
  const d = { db: Db.memory(), config, clock: { now: () => 1_793_000_000 } };
  saveBudgets(d, "all", MAX_BUDGET, MAX_BUDGET);
  saveBudgets(d, "web", MAX_BUDGET, 12.5);
  const back = loadConfig(file);
  expect(back.agent.dailyBudgetUsd).toBe(MAX_BUDGET);
  expect(back.budgets.monthlyUsd).toBe(MAX_BUDGET);
  expect(back.budgets.repos.get("web")).toEqual({ dailyUsd: MAX_BUDGET, monthlyUsd: 12.5 });
  // Above the ceiling the page refuses, rather than writing what the next start would refuse.
  expect(() => saveBudgets(d, "all", MAX_BUDGET + 1, undefined)).toThrow(
    "a budget is a positive amount in USD",
  );
  // "Raise to" never offers more than the ceiling.
  expect(raiseTo({ scope: "all", period: "day", spent: MAX_BUDGET, cap: MAX_BUDGET })).toBe(MAX_BUDGET);
});
