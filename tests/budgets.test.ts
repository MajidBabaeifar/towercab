// MET-31 to MET-34: budgets in config.toml, spend by month and repo, reached caps, cost estimates.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, expect, test } from "vitest";
import { capKey, capsOf, raiseTo, reloadBudgets, saveBudgets, setBudgetKey } from "../src/budgets.ts";
import { parseConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { estimateFor, freezeEstimate, frozenEstimate } from "../src/ui/estimate.ts";
import { spendPeriods } from "../src/ui/spend.ts";
import { Pipe } from "./helpers/pipe.ts";
import { tempDir, testConfig } from "./helpers/world.ts";

const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0).getTime() / 1000;
const NOW = local(26, 15);

const FILE = `# Towercab config
[intents]
remote = "https://github.com/me/intents.git"

[agent]
model = "opus"   # the model
daily_budget_usd = 80 # per day

[github]
app_id = 7
me = "me"

[repos.web]
github = "me/web"
`;

function configFile(text = FILE) {
  const file = join(tempDir("tc-budget-"), "config.toml");
  writeFileSync(file, text);
  return {
    file,
    config: () => parseConfig(parseToml(readFileSync(file, "utf8")) as Record<string, unknown>, file),
  };
}

function addMission(
  db: Db,
  p: {
    intent: string;
    repo?: string;
    stage?: string;
    cost?: number;
    runs?: unknown[];
    updated?: number;
    held?: number;
  },
) {
  const at = p.updated ?? NOW;
  db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, step, model, session, checkout, branch, cost_usd, held, data, created, updated)
     VALUES (?, ?, 1, ?, '', 'opus', 's', 'w', 'b', ?, ?, ?, ?, ?)`,
    p.intent,
    p.repo ?? "web",
    p.stage ?? "build",
    p.cost ?? 0,
    p.held ?? 0,
    JSON.stringify({ runs: p.runs ?? [] }),
    at - 3600,
    at,
  );
}

test("metrics: budgets are read from config.toml", () => {
  const { config } = configFile(
    `${FILE}\n[budget.web]\ndaily_usd = 20\nmonthly_usd = 300.5\n`.replace(
      "daily_budget_usd = 80 # per day",
      "daily_budget_usd = 80 # per day\nmonthly_budget_usd = 1500",
    ),
  );
  const c = config();
  expect(c.agent.dailyBudgetUsd).toBe(80);
  expect(c.budgets.monthlyUsd).toBe(1500);
  expect(c.budgets.repos.get("web")).toEqual({ dailyUsd: 20, monthlyUsd: 300.5 });
  expect(c.budgets.problems).toEqual([]);
});

test("metrics: a budget edit applies without a restart", () => {
  const { file, config } = configFile();
  const c = config();
  expect(c.budgets.monthlyUsd).toBeNull();
  writeFileSync(
    file,
    FILE.replace("daily_budget_usd = 80", "daily_budget_usd = 90\nmonthly_budget_usd = 1000"),
  );
  reloadBudgets(c);
  expect(c.agent.dailyBudgetUsd).toBe(90);
  expect(c.budgets.monthlyUsd).toBe(1000);
  // A line removed from the file means no limit.
  writeFileSync(file, FILE.replace("daily_budget_usd = 80 # per day\n", ""));
  reloadBudgets(c);
  expect(c.agent.dailyBudgetUsd).toBeNull();
  expect(c.budgets.monthlyUsd).toBeNull();
});

test("metrics: writing a budget leaves the rest of config.toml untouched", () => {
  const { file } = configFile();
  // Changing a line keeps its comment.
  setBudgetKey(file, "agent", "daily_budget_usd", 100);
  expect(readFileSync(file, "utf8")).toBe(
    FILE.replace("daily_budget_usd = 80 # per day", "daily_budget_usd = 100 # per day"),
  );
  // A new key goes into its table; a new repo table goes at the end.
  setBudgetKey(file, "agent", "monthly_budget_usd", 1500);
  setBudgetKey(file, "budget.web", "daily_usd", 12.5);
  const after = readFileSync(file, "utf8");
  expect(
    after.replace("monthly_budget_usd = 1500\n", "").replace("\n[budget.web]\ndaily_usd = 12.5\n", ""),
  ).toBe(FILE.replace("daily_budget_usd = 80 # per day", "daily_budget_usd = 100 # per day"));
  expect(parseToml(after)).toMatchObject({
    agent: { monthly_budget_usd: 1500 },
    budget: { web: { daily_usd: 12.5 } },
  });
  // Removing puts the file back as it was.
  setBudgetKey(file, "agent", "monthly_budget_usd", null);
  setBudgetKey(file, "budget.web", "daily_usd", null);
  setBudgetKey(file, "agent", "daily_budget_usd", 80);
  expect(readFileSync(file, "utf8").replace("\n[budget.web]\n", "")).toBe(FILE);
});

test("metrics: a bad budget key is ignored and shown as a problem", () => {
  const { file, config } = configFile(
    FILE.replace("daily_budget_usd = 80", "daily_budget_usd = 80\nmonthly_budget_usd = 500"),
  );
  const c = config();
  writeFileSync(
    file,
    FILE.replace("daily_budget_usd = 80", 'daily_budget_usd = 80\nmonthly_budget_usd = "lots"'),
  );
  reloadBudgets(c);
  expect(c.budgets.monthlyUsd).toBe(500);
  expect(c.budgets.problems).toHaveLength(1);
  expect(c.budgets.problems[0]).toContain("agent.monthly_budget_usd");
  writeFileSync(file, FILE);
  reloadBudgets(c);
  expect(c.budgets.problems).toEqual([]);
});

test("metrics: a part's runs count for its own repo", () => {
  const db = Db.memory();
  addMission(db, {
    intent: "i1",
    repo: "web",
    runs: [
      { at: local(26, 9), cost: 2 },
      { at: local(26, 10), cost: 3, repo: "api" },
    ],
  });
  const s = spendPeriods(db, NOW);
  expect(s.repos.get("web")?.day).toBeCloseTo(2);
  expect(s.repos.get("api")?.day).toBeCloseTo(3);
  expect(s.all.day).toBeCloseTo(5);
});

test("metrics: an invalid budget is refused", () => {
  const { file, config } = configFile();
  const c = config();
  const d = { db: Db.memory(), config: c, clock: { now: () => NOW } };
  for (const bad of [0, -5, "abc", 1.234, Number.POSITIVE_INFINITY]) {
    expect(() => saveBudgets(d, "all", bad, undefined), String(bad)).toThrow(
      "a budget is a positive amount in USD",
    );
  }
  expect(() => saveBudgets(d, "nope", 5, undefined)).toThrow("doesn't know a repo");
  expect(readFileSync(file, "utf8")).toBe(FILE);
});

test("metrics: spend this month and per repo", () => {
  const db = Db.memory();
  addMission(db, {
    intent: "i1",
    repo: "web",
    runs: [
      { at: local(26, 9), cost: 1.5 },
      { at: local(3, 9), cost: 4 },
      { at: new Date(2026, 8, 30, 12).getTime() / 1000, cost: 100 },
    ],
  });
  addMission(db, { intent: "i2", repo: "api", runs: [{ at: local(10, 9), cost: 2 }] });
  const s = spendPeriods(db, NOW);
  expect(s.all.day).toBeCloseTo(1.5);
  expect(s.all.month).toBeCloseTo(7.5);
  expect(s.repos.get("web")).toEqual({ day: 1.5, month: 5.5 });
  expect(s.repos.get("api")).toEqual({ day: 0, month: 2 });
});

/** A shadow turn costing `cost`, acting on `intent` (or on none). */
function shadowTurn(db: Db, cost: number, intent: string | null) {
  const { lastId } = db.run(
    "INSERT INTO shadow_turns (at, role, text, state, cost) VALUES (?, 'owner', 'x', 'done', ?)",
    NOW - 60,
    cost,
  );
  if (intent) {
    db.run(
      "INSERT INTO shadow_actions (at, turn, idx, action, intent, outcome) VALUES (?, ?, 0, 'merge', ?, 'done')",
      NOW - 60,
      lastId,
      intent,
    );
  }
}

test("metrics: shadow spend counts overall", () => {
  const db = Db.memory();
  addMission(db, { intent: "i1", repo: "web", runs: [{ at: local(26, 9), cost: 1 }] });
  shadowTurn(db, 2, null);
  const s = spendPeriods(db, NOW);
  expect(s.all.day).toBeCloseTo(3);
  expect(s.all.month).toBeCloseTo(3);
  expect(s.repos.get("web")?.day).toBeCloseTo(1);
});

test("metrics: shadow spend counts for a repo only when it acted on its intent", () => {
  const db = Db.memory();
  addMission(db, { intent: "i1", repo: "web", stage: "done" });
  shadowTurn(db, 2, "i1");
  shadowTurn(db, 5, null);
  const s = spendPeriods(db, NOW);
  expect(s.all.day).toBeCloseTo(7);
  expect(s.repos.get("web")?.day).toBeCloseTo(2);
});

const SPENT = [{ at: NOW - 60, cost: 45 }];
const INTENT = "---\nrepo: web\nu: 4\ni: 4\nsource: me\n---\n\n# Intent: Next thing\n";
const pipe = () => new Pipe({ "CLAUDE.md": "x\n" }, { "intents/261026-1000-next-thing/intent.md": INTENT });
const spentToday = (p: Pipe, repo = "web") =>
  addMission(p.db, {
    intent: "261026-0900",
    repo,
    stage: "done",
    runs: [{ at: p.clock.now() - 60, cost: 45 }],
  });
const FAST = { ci_grace: 0, ci_poll: 5, toolchain: [] as string[] };

afterEach(() => {
  /* Pipe restores the git config itself when it is cleaned up. */
});

test("metrics: a repo cap pauses only that repo", async () => {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    // web's own daily cap is reached: nothing in web is picked.
    const p = pipe();
    spentToday(p);
    await p.start({ agent: FAST, budget: { web: { daily_usd: 40 } } });
    expect((await p.loop.pass()).picked).toBeNull();
    // Another repo's cap being reached does not stop web.
    const q = pipe();
    spentToday(q, "other");
    await q.start({ agent: FAST, budget: { other: { daily_usd: 40 } } });
    expect((await q.loop.pass()).picked).toBe("261026-1000");
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

test("metrics: the monthly budget pauses all picks until the 1st", async () => {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    const p = pipe();
    spentToday(p);
    await p.start({ agent: { ...FAST, monthly_budget_usd: 40 } });
    expect((await p.loop.pass()).picked).toBeNull();
    // On the 1st of the next month the same spend no longer counts.
    const db = p.db;
    const config = p.loop.d.config;
    expect(capsOf(db, config, p.clock.now())).toHaveLength(1);
    expect(capsOf(db, config, new Date(2026, 10, 1, 8).getTime() / 1000)).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

test("metrics: raising a cap resumes at once", async () => {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    const p = pipe();
    spentToday(p);
    await p.start({ agent: FAST, budget: { web: { monthly_usd: 40 } } });
    expect((await p.loop.pass()).picked).toBeNull();
    p.loop.d.config.budgets.repos.get("web")!.monthlyUsd = 100;
    expect((await p.loop.pass()).picked).toBe("261026-1000");
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

/** What `meta.caps` holds after each of: a cap reached with a mission working, that mission at a wait, and back. */
async function underway(extra: Record<string, unknown>): Promise<string[]> {
  const p = pipe();
  await p.start(extra);
  addMission(p.db, { intent: "261026-0800", stage: "build", held: 1 });
  addMission(p.db, { intent: "261026-0801", stage: "approval:merge" });
  const id = (intent: string) =>
    p.db.get<{ id: number }>("SELECT id FROM missions WHERE intent = ?", intent)!.id;
  spentToday(p);
  const seen: string[] = [];
  const allowed = () => {
    const caps = JSON.parse(p.db.meta("caps") ?? "{}") as Record<string, number[]>;
    return Object.values(caps)
      .flat()
      .map((n) => (n === id("261026-0800") ? "working" : n === id("261026-0801") ? "waiting" : "other"))
      .join(",");
  };
  await p.loop.pass();
  seen.push(allowed());
  // The working mission reaches a wait on the owner: it is no longer underway.
  p.db.run("UPDATE missions SET stage = 'approval:merge', held = 0 WHERE intent = '261026-0800'");
  await p.loop.pass();
  seen.push(allowed());
  // Answered, it is back at work: a cap holds its next run.
  p.db.run("UPDATE missions SET stage = 'build', held = 1 WHERE intent = '261026-0800'");
  await p.loop.pass();
  seen.push(allowed());
  return seen;
}

test("metrics: an intent underway finishes its run and stops at its next owner wait", async () => {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    // The mission working when the cap is reached may carry on; the one already waiting may not.
    expect(await underway({ agent: { ...FAST, daily_budget_usd: 40 } })).toEqual(["working", "", ""]);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

test("metrics: the overall budget and a repo cap use the same rule", async () => {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    const overall = await underway({ agent: { ...FAST, daily_budget_usd: 40 } });
    const repo = await underway({ agent: FAST, budget: { web: { daily_usd: 40 } } });
    expect(repo).toEqual(overall);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

test("metrics: a reached cap is noticed once", async () => {
  const saved = process.env.GIT_CONFIG_GLOBAL;
  try {
    const p = pipe();
    spentToday(p);
    await p.start({ agent: { ...FAST, daily_budget_usd: 40 } });
    for (let i = 0; i < 3; i++) await p.loop.pass();
    expect(p.logs.filter((l) => l.includes("daily budget reached"))).toHaveLength(1);
    const c = capsOf(p.db, p.loop.d.config, p.clock.now())[0]!;
    expect(capKey(c, p.clock.now())).toMatch(/^all:day:2026-/);
    expect(raiseTo({ ...c, cap: 40, spent: 45 })).toBe(50);
    expect(raiseTo({ ...c, cap: 200, spent: 200 })).toBe(220);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

function done(db: Db, repo: string, costs: number[]) {
  for (const [n, cost] of costs.entries()) {
    addMission(db, { intent: `${repo}-${n}-${costs.length}`, repo, stage: "done", cost });
  }
}

test("metrics: estimate is the median of the repo's last done intents", () => {
  const db = Db.memory();
  done(db, "web", [1, 2, 3, 4, 5]);
  done(db, "api", [50, 60, 70]);
  expect(estimateFor(db, "web")).toEqual({ median: 3, low: 2, high: 4, basis: "repo" });
  // Only the last 10 count.
  const many = Db.memory();
  done(many, "web", [100, 100, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  expect(estimateFor(many, "web")?.median).toBe(1);
});

test("metrics: estimate falls back to all repos", () => {
  const db = Db.memory();
  done(db, "web", [1, 2]);
  done(db, "api", [3, 4, 5]);
  expect(estimateFor(db, "web")).toEqual({ median: 3, low: 2, high: 4, basis: "all" });
});

test("metrics: no estimate with fewer than 3 done", () => {
  const db = Db.memory();
  expect(estimateFor(db, "web")).toBeNull();
  done(db, "web", [1, 2]);
  expect(estimateFor(db, "web")).toBeNull();
});

test("metrics: the estimate is frozen at start", () => {
  const db = Db.memory();
  done(db, "web", [1, 2, 3]);
  addMission(db, { intent: "next", repo: "web", stage: "pick" });
  const m = freezeEstimate(db, db.get("SELECT * FROM missions WHERE intent = 'next'")!, NOW);
  expect(frozenEstimate(m)).toEqual({ median: 2, low: 1.5, high: 2.5, basis: "repo" });
  // Later spending changes the estimate for others, not this mission's.
  done(db, "web", [30, 40, 50, 60]);
  expect(estimateFor(db, "web")?.median).not.toBe(2);
  expect(frozenEstimate(db.get("SELECT * FROM missions WHERE intent = 'next'")!)?.median).toBe(2);
  void testConfig;
  void SPENT;
});
