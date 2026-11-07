// UI-253 to UI-256: budgets in the page, the cap card, estimates on intents, the top bar's spend.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { BAD_BUDGET } from "../../src/budgets.ts";
import { createActions, type UiActions } from "../../src/ui/actions.ts";
import { topBudget } from "../../src/ui/budget-view.ts";
import { estimateLine } from "../../src/ui/estimate.ts";
import { repos } from "../../src/ui/repos.ts";
import { startUi } from "../../src/ui/server.ts";
import { activity, needCounts, overview, snapshot, spend } from "../../src/ui/state.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";
import { tempDir } from "../helpers/world.ts";
import { post } from "./http.ts";

// Mon 26 Oct 2026, 23:00:00 local time.
const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const FILE = '# mine\n[agent]\ndaily_budget_usd = 40 # a day\n\n[repos.web]\ngithub = "acme/web"\n';

/** The fixture with its config pointing at a real file, and actions that write to it. */
function setup(): { f: Fixture; file: string; actions: UiActions } {
  const f = buildFixture({ now: NOW });
  cleanup.push(() => f.cleanup());
  const file = join(tempDir("tc-ui-budget-"), "config.toml");
  writeFileSync(file, FILE);
  f.sources.config.file = file;
  f.sources.config.agent.dailyBudgetUsd = 40;
  f.sources.config.budgets.monthlyUsd = null;
  const actions = createActions({
    db: f.db,
    store: f.store,
    config: f.sources.config,
    clock: f.sources.clock,
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  });
  return { f, file, actions };
}

const settingsRows = async (f: Fixture) => (await activity(f.sources, { kind: "settings" })).items;

test("ui: the budget section saves daily and monthly amounts", async () => {
  const { f, actions } = setup();
  expect((await overview(f.sources)).spend.budgets?.daily).toBe(40);
  expect(await actions.budgets!("all", 100, 2000)).toBe("Saved. Applies now.");
  const b = (await overview(f.sources)).spend.budgets!;
  expect([b.scope, b.daily, b.monthly]).toEqual(["all", 100, 2000]);
  expect(b.where).toBe("Saved in config.toml on this machine.");
  // An empty field removes the limit.
  await actions.budgets!("all", null, null);
  expect((await overview(f.sources)).spend.budgets).toMatchObject({ daily: null, monthly: null });
});

test("ui: a repo page has its own caps", async () => {
  const { f, file, actions } = setup();
  await actions.budgets!("web", 12, 150);
  const page = (await repos(f.sources, "web")).repo!;
  expect(page.budgets).toMatchObject({ scope: "web", daily: 12, monthly: 150 });
  expect(readFileSync(file, "utf8")).toContain("[budget.web]\ndaily_usd = 12\nmonthly_usd = 150");
  // The overall budget is not touched by a repo's caps.
  expect((await overview(f.sources)).spend.budgets?.daily).toBe(40);
});

test("ui: an invalid budget is refused in the form and by the server", async () => {
  const { f, file, actions } = setup();
  const ui = startUi({ port: 0, sources: f.sources, actions, distDir: tempDir(), log: () => {} });
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  for (const daily of [-1, 0, "abc", 1.005]) {
    const bad = await post(port, ui.token, { action: "budgets", scope: "all", daily });
    expect(bad.status, String(daily)).toBe(422);
    expect(JSON.parse(bad.body).message).toBe(BAD_BUDGET);
  }
  expect(readFileSync(file, "utf8")).toBe(FILE);
  const ok = await post(port, ui.token, { action: "budgets", scope: "all", daily: 55 });
  expect(ok.status).toBe(200);
  // The form's own check is the server's rule: a positive amount of at most two decimals.
  const source = readFileSync(join(import.meta.dirname, "../../ui/src/budgets.tsx"), "utf8");
  expect(source).toContain("A budget is a positive amount in USD");
});

test("ui: a budget save is written to config.toml", async () => {
  const { file, actions, f } = setup();
  await actions.budgets!("all", 60, 900);
  expect(readFileSync(file, "utf8")).toBe(
    FILE.replace("daily_budget_usd = 40 # a day", "daily_budget_usd = 60 # a day\nmonthly_budget_usd = 900"),
  );
  expect(f.sources.config.agent.dailyBudgetUsd).toBe(60);
  expect(f.sources.config.budgets.monthlyUsd).toBe(900);
});

test("ui: a budget change shows in activity as old to new", async () => {
  const { f, actions } = setup();
  await actions.budgets!("all", 100, undefined);
  await actions.budgets!("web", 5, 50);
  const texts = (await settingsRows(f)).map((r) => r.text).sort();
  expect(texts).toEqual([
    "daily budget: $40 → $100",
    "web daily cap: none → $5",
    "web monthly cap: none → $50",
  ]);
  expect((await settingsRows(f)).every((r) => r.kind === "settings")).toBe(true);
});

test("ui: an unchanged save records nothing", async () => {
  const { f, file, actions } = setup();
  expect(await actions.budgets!("all", 40, null)).toBe("Nothing changed.");
  expect(readFileSync(file, "utf8")).toBe(FILE);
  expect(await settingsRows(f)).toEqual([]);
});

/** Today's spend, so a budget can be set right at it. */
const today = (f: Fixture) => spend(f.db, NOW).today;

test("ui: a reached cap shows a card with the amounts", async () => {
  const { f } = setup();
  f.sources.config.agent.dailyBudgetUsd = Math.max(today(f), 1);
  const o = await overview(f.sources);
  expect(o.spend.caps).toHaveLength(1);
  const c = o.spend.caps![0]!;
  expect(c.title).toMatch(/^Daily budget reached: \$\d+\.\d\d of \$\d+\.\d\d$/);
  expect(c.line).toBe("Work for Towercab is paused until midnight.");
  expect(c.raiseTo).toBeGreaterThan(c.capUsd);
  expect(c.waiting).toBeGreaterThanOrEqual(0);
  // A repo's cap names the repo and the period.
  f.sources.config.agent.dailyBudgetUsd = null;
  f.sources.config.budgets.repos.set("web", { dailyUsd: null, monthlyUsd: 0.01 });
  const r = (await overview(f.sources)).spend.caps ?? [];
  expect(r.map((x) => x.title.split(":")[0])).toEqual(["web reached its monthly cap"]);
  expect(r[0]!.line).toBe("Work for web is paused until the 1st.");
});

test("ui: raising the cap from the card resumes work", async () => {
  const { f, actions } = setup();
  f.sources.config.agent.dailyBudgetUsd = Math.max(today(f), 1);
  const card = (await overview(f.sources)).spend.caps![0]!;
  await actions.budgets!("all", card.raiseTo, undefined);
  expect((await overview(f.sources)).spend.caps).toEqual([]);
  expect(f.sources.config.agent.dailyBudgetUsd).toBe(card.raiseTo);
});

test("ui: the cap card counts as needing you", async () => {
  const { f } = setup();
  f.sources.config.agent.dailyBudgetUsd = 100000;
  const before = (await overview(f.sources)).top.needs;
  f.sources.config.agent.dailyBudgetUsd = Math.max(today(f), 1);
  const o = await overview(f.sources);
  expect(o.top.needs).toBe(before + 1);
  expect(needCounts(f.sources, await snapshot(f.sources)).total).toBe(o.top.needs);
});

test("ui: the cap card goes when the period ends", async () => {
  const { f } = setup();
  f.sources.config.agent.dailyBudgetUsd = Math.max(today(f), 1);
  expect((await overview(f.sources)).spend.caps).toHaveLength(1);
  const tomorrow = { ...f.sources.clock, now: () => NOW + 24 * 3600 };
  expect((await overview({ ...f.sources, clock: tomorrow })).spend.caps).toEqual([]);
});

const EST = { median: 10, low: 8, high: 12, basis: "repo" as const };

test("ui: an unstarted intent shows its estimate", async () => {
  const { f } = setup();
  for (const [n, cost] of [1, 2, 3].entries()) {
    f.db.run(
      `INSERT INTO missions (intent, repo, attempt, stage, step, model, session, checkout, branch, cost_usd, created, updated)
       VALUES (?, 'web', 1, 'done', '', 'opus', 's', 'w', 'b', ?, ?, ?)`,
      `est-${n}`,
      cost,
      NOW - 100,
      NOW - 50,
    );
  }
  expect(estimateLine({ median: 2, low: 1.5, high: 2.5, basis: "repo" }, null).text).toBe(
    "Estimated $1.50–$2.50, about $2.00",
  );
  const o = await overview(f.sources);
  expect(o.upNext.length).toBeGreaterThan(0);
  for (const u of o.upNext)
    expect(u.estimate?.text).toMatch(/^Estimated \$\d+\.\d\d–\$\d+\.\d\d, about \$\d+\.\d\d$/);
  for (const q of o.queued) expect(q.estimate?.pct).toBeNull();
});

function withEstimate(f: Fixture, cost: number) {
  const m = f.db.get<{ id: number }>(
    "SELECT id FROM missions WHERE stage NOT IN ('done','stopped') AND waiting IS NULL ORDER BY id",
  )!;
  f.db.run(
    "UPDATE missions SET cost_usd = ?, data = json_set(data, '$.estimate', json(?)) WHERE id = ?",
    cost,
    JSON.stringify(EST),
    m.id,
  );
}

test("ui: a running intent shows spent against the estimate", async () => {
  const { f } = setup();
  withEstimate(f, 5);
  const o = await overview(f.sources);
  const rows = [...o.working, ...o.queued].filter((r) => r.estimate?.pct === 50);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]!.estimate).toEqual({ text: "$5.00 of about $10.00", pct: 50, over: false });
});

test("ui: no estimate says so", async () => {
  const { f } = setup();
  // Fewer than 3 done intents anywhere: the finished ones are set aside, not deleted.
  f.db.run("UPDATE missions SET stage = 'stopped' WHERE stage = 'done'");
  expect(estimateLine(null, null)).toEqual({ text: "No estimate yet", pct: null, over: false });
  const o = await overview(f.sources);
  for (const u of o.upNext) expect(u.estimate?.text).toBe("No estimate yet");
});

test("ui: the over-estimate bar turns amber", async () => {
  const { f } = setup();
  withEstimate(f, 15);
  const o = await overview(f.sources);
  const over = [...o.working, ...o.queued].find((r) => r.estimate?.over);
  expect(over?.estimate).toEqual({
    text: "$15.00 of about $10.00 · over the usual range",
    pct: 100,
    over: true,
  });
  // The page paints it amber and the text says it too.
  const css = readFileSync(join(import.meta.dirname, "../../ui/src/styles.css"), "utf8");
  expect(css).toMatch(/\.estimate\.amber \.est-bar i/);
});

const CONFIG = (daily: number | null, monthly: number | null) => {
  const f = buildFixture({ now: NOW, empty: true });
  cleanup.push(() => f.cleanup());
  f.sources.config.agent.dailyBudgetUsd = daily;
  f.sources.config.budgets.monthlyUsd = monthly;
  return f.sources.config;
};

test("ui: top bar shows spend against the budget", async () => {
  expect(topBudget(CONFIG(40, 1000), 10, 100)).toEqual({
    text: "$10.00 of $40.00 · $100.00 of $1000.00 this month",
    level: "ok",
    note: null,
  });
  expect(topBudget(CONFIG(null, null), 10, 100).text).toBe("$10.00 today");
  expect(topBudget(CONFIG(40, null), 10, 100).text).toBe("$10.00 of $40.00");
  const { f } = setup();
  const top = (await overview(f.sources)).top;
  expect(top.budgetChip?.text).toContain(` of $40.00`);
});

test("ui: top bar turns amber at 80 percent", () => {
  const c = CONFIG(40, null);
  expect(topBudget(c, 31.99, 0).level).toBe("ok");
  expect(topBudget(c, 32, 0)).toMatchObject({ level: "amber", note: "80% used" });
  // Either budget turns it.
  expect(topBudget(CONFIG(1000, 100), 1, 80)).toMatchObject({ level: "amber", note: "80% used" });
});

test("ui: top bar says budget reached", () => {
  expect(topBudget(CONFIG(40, null), 40, 0)).toMatchObject({ level: "red", note: "Budget reached" });
  expect(topBudget(CONFIG(1000, 100), 1, 100)).toMatchObject({ level: "red", note: "Budget reached" });
});
