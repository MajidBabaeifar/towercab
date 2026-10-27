// UI-56 to UI-64, UI-71: what the page shows, derived on the server.

import { afterEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import type { Stage } from "../../src/machine.ts";
import type { Mission } from "../../src/mission.ts";
import {
  activity,
  ago,
  duration,
  exactTime,
  intentPage,
  money,
  moveWords,
  overview,
  queue,
  stateOf,
  stepWords,
  until,
} from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";
import { testConfig } from "../helpers/world.ts";

// Mon 26 Oct 2026, 23:00:00 local time.
const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: Fixture[] = [];
afterEach(() => {
  while (open.length) open.pop()!.cleanup();
});
function fixture(o: { empty?: boolean } = {}): Fixture {
  const f = buildFixture({ now: NOW, ...o });
  open.push(f);
  return f;
}

function mission(p: Partial<Mission>): Mission {
  return {
    id: 1,
    intent: "261026-0900-1",
    repo: "web",
    attempt: 1,
    stage: "build",
    step: "",
    from_stage: null,
    waiting: null,
    why: null,
    continued: 0,
    busy: 0,
    unclean: 0,
    held: 0,
    model: "opus",
    a_at_pick: null,
    session: "s",
    session_used: 0,
    checkout: "work/x",
    branch: "towercab/x",
    base_sha: null,
    head: null,
    spec_pr: null,
    plan_pr: null,
    pr: null,
    pushed_at: null,
    feedback_seen: null,
    merged_by: null,
    merge_sha: null,
    repairs: 0,
    ci_repairs: 0,
    retries: 0,
    retry_at: null,
    limit_model: null,
    step_secs: 0,
    child_pid: null,
    child_kind: null,
    child_since: null,
    child_model: null,
    cost_usd: 0,
    agent_secs: 0,
    data: "{}",
    created: NOW - 3600,
    updated: NOW - 60,
    finished: null,
    ...p,
  };
}

test("ui: one state per mission", () => {
  const config = testConfig();
  const at = (stage: Stage, p: Partial<Mission> = {}, entered = NOW - 60) =>
    stateOf(mission({ stage, ...p }), NOW, { enteredAt: entered, config, cooldownUntil: NOW + 1800 });
  expect(at("approval:plan", { waiting: "approve plan" })).toEqual({
    key: "needs",
    label: "Needs you",
    note: "Plan review",
  });
  expect(at("blocked", { waiting: "answer the question" }).note).toBe("Question");
  expect(at("blocked", { waiting: "CI red" }).note).toBe("Blocked");
  expect(at("build").label).toBe("Working");
  expect(at("ci").label).toBe("Waiting on CI");
  expect(at("ci", {}, NOW - 3 * 3600).label).toBe("Stalled");
  expect(at("verify", {}, NOW - 25 * 60).label).toBe("Stalled");
  expect(at("verify", {}, NOW - 15 * 60).label).toBe("Working");
  expect(at("build", {}, NOW - 100 * 60).label).toBe("Working");
  expect(at("build", {}, NOW - 121 * 60).label).toBe("Stalled");
  const cooling = at("build", { limit_model: "opus" }, NOW - 5 * 3600);
  expect(cooling.label).toBe("Cooling down");
  expect(cooling.note).toMatch(/^until \d\d:\d\d$/);
  expect(at("merge", { held: 1 }).label).toBe("Paused");
  expect(at("done").label).toBe("Done");
  expect(at("stopped").label).toBe("Dropped");
});

test("ui: steps in plain words", async () => {
  const words: [Stage, string][] = [
    ["design", "Writing the spec"],
    ["approval:spec", "Waiting for your spec review"],
    ["plan", "Planning"],
    ["build", "Building"],
    ["verify", "Running checks"],
    ["proof", "Proving the tests"],
    ["publish", "Opening the PR"],
    ["ci", "Waiting for CI"],
    ["review", "Reviewing"],
    ["merge", "Merging"],
  ];
  for (const [stage, w] of words) expect(stepWords(stage)).toBe(w);
  const f = fixture();
  const o = await overview(f.sources);
  const page = await intentPage(f.sources, IDS.stalled);
  const shown = [...o.working.map((r) => r.step), ...page!.timeline.map((t) => t.text)];
  for (const s of shown) expect(s).not.toMatch(/approval:|_merged|\bci\b|\bverify\b|retry_fresh/);
});

test("ui: top bar shows health and counts", async () => {
  const f = fixture();
  let o = await overview(f.sources);
  expect(o.top).toMatchObject({
    health: "Problem",
    needs: 4,
    working: 4,
    queued: 3,
    paused: false,
    readOnly: false,
  });
  expect(o.top.countsText).toBe("4 need you · 4 working · 3 queued");
  expect(o.top.spendToday).toMatch(/^\$\d+\.\d\d$/);
  expect(o.top.budget).toBe("of $40.00");
  expect(o.top.version).toEqual({ commit: "3f9c2ab", behind: "up to date" });
  f.state.running = false;
  o = await overview(f.sources);
  expect(o.top.health).toBe("Not running");
  expect(o.top.readOnly).toBe(true);
  expect(o.top.banner).toMatch(/isn't running/);
  const e = fixture({ empty: true });
  e.state.paused = true;
  o = await overview(e.sources);
  expect(o.top.health).toBe("Paused");
  expect(o.top.countsText).toBe("0 need you · 0 working · 0 queued");
  e.state.paused = false;
  expect((await overview(e.sources)).top.health).toBe("Running");
});

test("ui: needs-you card shows only its actions", async () => {
  const f = fixture();
  const o = await overview(f.sources);
  const card = (id: string) => o.needs.find((c) => c.intent === id)!;
  // Oldest wait first.
  expect(o.needs.map((c) => c.intent)).toEqual([IDS.code, IDS.plan, IDS.question, IDS.crm]);
  const plan = card(IDS.plan);
  expect(plan.actions).toEqual(["merge", "retry", "drop"]);
  expect(plan.mergeLabel).toBe("Merge plan PR");
  expect(plan.ask).toBe("Review the plan and its access list, then merge the plan PR.");
  expect(plan.access?.domains.map((d) => d.domain)).toEqual(["redis.io", "registry.npmjs.org"]);
  expect(plan.pr).toEqual({
    number: 31,
    url: "https://github.com/acme/intents/pull/31",
    label: "Plan PR #31",
  });
  const code = card(IDS.code);
  expect(code.mergeLabel).toBe("Merge PR");
  expect(code.brief).toMatch(/five-minute path/);
  expect(code.access).toBeNull();
  const q = card(IDS.question);
  expect(q.actions).toEqual(["reply", "retry", "drop"]);
  expect(q.mergeLabel).toBeNull();
  expect(q.question?.options).toHaveLength(3);
  expect(q.question?.recommendation).toMatch(/^One totals row per currency/);
  const crm = card(IDS.crm);
  expect(crm.actions).toEqual(["reply", "drop"]);
  expect(crm.why).toMatch(/crm/);
});

test("ui: empty states are true", async () => {
  const e = fixture({ empty: true });
  const o = await overview(e.sources);
  expect(o.needs).toEqual([]);
  expect(o.working).toEqual([]);
  expect(o.queued).toEqual([]);
  expect(o.upNext).toEqual([]);
  expect(o.problems).toEqual([]);
  expect(o.spend.today).toBe("$0.00");
  const q = await queue(e.sources);
  expect(q.lanes.every((l) => l.running.length + l.waiting.length + l.done.length === 0)).toBe(true);
  expect((await activity(e.sources)).items).toEqual([]);
});

test("ui: working row shows phase and step", async () => {
  const f = fixture();
  const o = await overview(f.sources);
  const ci = o.working.find((r) => r.intent === IDS.ci)!;
  expect(ci).toMatchObject({
    title: "Faster checkout page",
    repo: "web",
    step: "Waiting for CI",
    inStep: "4 min",
    cost: "$1.36",
    model: "Opus",
  });
  expect(ci.state.label).toBe("Waiting on CI");
  expect(ci.phases.map((p) => p.status)).toEqual(["skipped", "done", "current"]);
  const b = o.working.find((r) => r.intent === IDS.building)!;
  expect(b.phases.map((p) => p.status)).toEqual(["done", "done", "current"]);
  expect(b.step).toBe("Building");
  const cool = o.working.find((r) => r.intent === IDS.cooling)!;
  expect(cool.state.label).toBe("Cooling down");
  expect(cool.model).toBe("Sonnet");
  expect(o.queued.find((r) => r.intent === IDS.queued)?.behind).toBe(
    "3 intents are already ahead of build in this repo; it starts when one has a place free, or when you start it.",
  );
});

test("ui: problems only when there are some", async () => {
  expect((await overview(fixture({ empty: true }).sources)).problems).toEqual([]);
  const f = fixture();
  const p = (await overview(f.sources)).problems;
  const keys = p.map((x) => x.key.split(":")[0]);
  expect(keys).toEqual(["stalled", "repeat", "cost", "unreadable"]);
  expect(p[0]!.title).toBe("“Rotate log files daily” has not moved for 3 h 12 min.");
  expect(p[1]).toMatchObject({ detail: "logrotate test: expected 7 files, found 0", code: true });
  for (const x of p) expect(x.fix.length).toBeGreaterThan(10);
  f.sources.problems = () => [
    { title: "GitHub can't be reached.", fix: "Check the network.", since: NOW - 1200 },
  ];
  const withLoop = (await overview(f.sources)).problems;
  expect(withLoop[0]).toMatchObject({
    title: "GitHub can't be reached.",
    detail: "Since 20 min ago.",
    tone: "error",
  });
});

test("ui: up next explains skips", async () => {
  const f = fixture();
  f.state.upNext = [
    { intent: IDS.upnext, priority: 11, skip: null },
    { intent: IDS.queued, priority: 10, skip: { kind: "ahead", n: 3, limit: 3 } },
    {
      intent: IDS.queued2,
      priority: 9,
      skip: { kind: "cooling", model: "claude-sonnet-4", until: NOW + 47 * 60 },
    },
    { intent: IDS.parked2, priority: 6, skip: { kind: "parked" } },
    { intent: IDS.parked1, priority: 5, skip: { kind: "after", intent: IDS.done1 } },
  ];
  const u = (await overview(f.sources)).upNext;
  expect(u.map((x) => [x.state.label, x.reason])).toEqual([
    ["Up next", null],
    [
      "Queued",
      "3 intents are already ahead of build in this repo; it starts when one has a place free, or when you start it.",
    ],
    ["Cooling down", "Sonnet is cooling down after a usage limit; it can start in 47 min."],
    ["Parked", "Raise its urgency or importance to run it."],
    ["Queued", "Waits for “Sign in with GitHub” to be done."],
  ]);
  f.state.paused = true;
  expect((await overview(f.sources)).upNext[0]).toMatchObject({
    state: { label: "Paused" },
    reason: "New work starts when you resume.",
  });
});

test("ui: intent page shows the three PRs", async () => {
  const f = fixture();
  const prs = async (id: string) =>
    (await intentPage(f.sources, id))!.prs.map((p) => [p.label, p.state, p.number]);
  expect(await prs(IDS.plan)).toEqual([
    ["Spec", "merged", 118],
    ["Plan", "open", 31],
    ["Code", "not yet", null],
  ]);
  expect(await prs(IDS.ci)).toEqual([
    ["Spec", "not needed", null],
    ["Plan", "merged", 32],
    ["Code", "open", 215],
  ]);
  expect(await prs(IDS.done2)).toEqual([
    ["Spec", "merged", 112],
    ["Plan", "merged", 25],
    ["Code", "merged", 114],
  ]);
  expect((await prs(IDS.dropped))[0]).toEqual(["Spec", "closed", 70]);
  const page = (await intentPage(f.sources, IDS.plan))!;
  expect(page.prs[0]!.url).toBe("https://github.com/acme/api/pull/118");
  expect(page.prs[1]!.url).toBe("https://github.com/acme/intents/pull/31");
  expect(page.card?.mergeLabel).toBe("Merge plan PR");
  expect(page.sentence).toBe("Waiting for your plan review for 2 h 10 min.");
  expect(page.scores).toBe("Priority 14 · urgency 4, importance 5, autonomy 2");
  expect(page.sections.map((s) => s.title)).toEqual(["Why", "Outcome"]);
  expect(page.runs.map((g) => g.step)).toEqual(["Writing the spec", "Planning"]);
  expect(await intentPage(f.sources, "999999-0000-1")).toBeNull();
});

test("ui: the intent page links its issue", async () => {
  const f = fixture();
  expect((await intentPage(f.sources, IDS.upnext))!.issue).toBe("https://github.com/acme/blog/issues/12");
  expect((await intentPage(f.sources, IDS.plan))!.issue).toBeNull();
});

test("ui: timeline in plain words", async () => {
  const f = fixture();
  const page = (await intentPage(f.sources, IDS.plan))!;
  expect(page.timeline.map((t) => t.text)).toEqual([
    "Picked up (Opus)",
    "Started writing the spec",
    "Asked you to review the spec PR",
    "Spec PR merged; planning starts",
    "Asked you to review the plan",
  ]);
  expect(page.timeline.map((t) => t.lasted)).toEqual([null, "59 min", "20 h 00 min", "2 h 50 min", null]);
  expect(page.timeline[4]!.tone).toBe("wait");
  const stalled = (await intentPage(f.sources, IDS.stalled))!;
  const red = stalled.timeline.find((t) => t.tone === "error")!;
  expect(red).toMatchObject({
    text: "Running checks failed; back to building",
    why: "logrotate test: expected 7 files, found 0",
  });
  expect(
    moveWords({ from_stage: "approval:merge", event: "closed", to_stage: "stopped", why: "PR closed" }),
  ).toBe("Dropped: the PR was closed");
  expect(moveWords({ from_stage: "blocked", event: "answered", to_stage: "build", why: null })).toBe(
    "You answered; back to building",
  );
  const retried = (await intentPage(f.sources, IDS.done1))!;
  expect(retried.timeline.map((t) => t.text)).toContain("Attempt 2 started (Opus)");
  expect(retried.attempts.map((a) => [a.attempt, a.state.label, a.cost])).toEqual([
    [1, "Dropped", "$1.20"],
    [2, "Done", "$5.10"],
  ]);
});

test("ui: queue lanes by repo", async () => {
  const f = fixture();
  const q = await queue(f.sources);
  expect(q.lanes.map((l) => l.repo)).toEqual(["web", "api", "docs", "mobile", "infra", "blog"]);
  const web = q.lanes[0]!;
  expect(web.github).toBe("acme/web");
  expect(web.running.map((r) => r.intent)).toEqual([IDS.question, IDS.ci]);
  expect(web.waiting.map((w) => [w.position, w.title, w.reason])).toEqual([
    [
      1,
      "Dark mode for the settings page",
      "3 intents are already ahead of build in this repo; it starts when one has a place free, or when you start it.",
    ],
  ]);
  expect(web.parked.map((w) => w.title)).toEqual(["Try a new chart library"]);
  expect(web.done.map((w) => [w.title, w.state.label, w.cost])).toEqual([
    ["Sign in with GitHub", "Done", "$6.30"],
    ["Fix the typo on the pricing page", "Done", "$2.60"],
  ]);
  const blog = q.lanes[5]!;
  expect(blog.running).toEqual([]);
  expect(blog.waiting[0]).toMatchObject({
    title: "Add an RSS feed to the blog",
    state: { label: "Up next" },
    reason: null,
  });
  expect(q.lanes[3]!.done[0]!.state.label).toBe("Dropped");
});

test("ui: activity API applies filters", async () => {
  const f = fixture();
  const all = await activity(f.sources);
  expect(all.items.length).toBe(100);
  expect(all.more).toBe(true);
  for (let i = 1; i < all.items.length; i++)
    expect(all.items[i - 1]!.at.at).toBeGreaterThanOrEqual(all.items[i]!.at.at);
  const waits = await activity(f.sources, { kind: "waits" });
  expect(waits.items.every((x) => x.kind === "wait")).toBe(true);
  const errors = await activity(f.sources, { kind: "errors", since: "24h" });
  expect(errors.items.map((x) => x.text)).toContain("github: api.github.com timed out; retrying in 30 s");
  expect(errors.items.every((x) => x.kind === "error" && x.at.at >= NOW - 86400)).toBe(true);
  const one = await activity(f.sources, { intent: IDS.plan });
  expect(one.items.every((x) => x.intent === IDS.plan && x.title === "Rate-limit the public API")).toBe(true);
  expect(one.items).toHaveLength(4);
  const repo = await activity(f.sources, { repo: "infra" });
  expect(repo.items.every((x) => x.repo === "infra")).toBe(true);
  const cooling = await activity(f.sources, { intent: IDS.cooling });
  expect(
    cooling.items.some((x) => x.kind === "log" && x.text === "sonnet hit its usage limit; resets in 67 min"),
  ).toBe(true);
  const page2 = await activity(f.sources, { offset: 100 });
  expect(page2.items[0]!.key).not.toBe(all.items[0]!.key);
});

test("ui: times, costs and durations", () => {
  expect(duration(45)).toBe("45 s");
  expect(duration(12 * 60)).toBe("12 min");
  expect(duration(3900)).toBe("1 h 05 min");
  expect(duration(26 * 3600)).toBe("1 d 2 h");
  expect(money(1.234)).toBe("$1.23");
  expect(money(0)).toBe("$0.00");
  expect(money(12.5)).toBe("$12.50");
  expect(ago(NOW - 10, NOW)).toBe("just now");
  expect(ago(NOW - 12 * 60, NOW)).toBe("12 min ago");
  expect(ago(NOW - 3 * 3600, NOW)).toBe("3 h ago");
  const local = (d: number, h: number) => new Date(2026, 9, d, h, 0, 0).getTime() / 1000;
  expect(ago(local(25, 23), NOW)).toBe("yesterday 23:00");
  expect(ago(local(23, 23), NOW)).toBe("Fri 23:00");
  expect(ago(local(6, 12), NOW)).toBe("6 Oct");
  expect(until(NOW + 47 * 60, NOW)).toBe("in 47 min");
  expect(until(local(27, 5), NOW)).toBe("tomorrow 05:00");
  expect(exactTime(NOW)).toBe("Mon 26 Oct 2026, 23:00:00");
});

test("ui: a fresh database has an overview", async () => {
  const f = fixture({ empty: true });
  f.sources.db = Db.memory();
  const o = await overview(f.sources);
  expect(o.version).toMatch(/^[0-9a-f]{12}$/);
});

test("ui: airspace places each intent at its station", async () => {
  const f = fixture();
  const a = (await overview(f.sources)).airspace;
  const at = Object.fromEntries(a.planes.map((p) => [p.intent, [p.station, p.state.label]]));
  expect(at).toEqual({
    [IDS.parked2]: ["parked", "Parked"],
    [IDS.parked1]: ["parked", "Parked"],
    [IDS.queued]: ["queue", "Queued"],
    [IDS.queued2]: ["queue", "Queued"],
    [IDS.crm]: ["gate", "Needs you"],
    [IDS.upnext]: ["gate", "Up next"],
    [IDS.plan]: ["plan-review", "Needs you"],
    [IDS.question]: ["code", "Needs you"],
    [IDS.building]: ["code", "Working"],
    [IDS.cooling]: ["code", "Cooling down"],
    [IDS.stalled]: ["code", "Stalled"],
    [IDS.ci]: ["ci", "Waiting on CI"],
    [IDS.code]: ["code-review", "Needs you"],
  });
  // In line order, so Tab follows the line.
  expect(a.planes[0]!.station).toBe("parked");
  expect(a.planes.at(-1)!.station).toBe("code-review");
  const ci = a.planes.find((p) => p.intent === IDS.ci)!;
  expect(ci.lines).toEqual(["Waiting for CI · 4 min", "$1.36 · Opus"]);
  expect(a.planes.find((p) => p.intent === IDS.queued)!.lines).toEqual([
    "#2 in line · priority 10",
    "3 intents are already ahead of build in this repo; it starts when one has a place free, or when you start it.",
  ]);
  // Done today only: not yesterday's, not the dropped one.
  expect(a.landed).toEqual({
    count: 2,
    cost: "$6.70",
    agentTime: "1 h 13 min",
    recent: [
      { intent: IDS.landed, title: "Readable CI job names", repo: "blog" },
      { intent: IDS.done2, title: "Paginate the orders API", repo: "api" },
    ],
  });
  expect(a.counts).toEqual({ parked: 2, queued: 3, flying: 4, needs: 4, landed: 2 });
  expect(a.countsText).toBe("4 in flight · 4 need you · 2 landed today");
  expect(a.summary).toBe("Airspace: 2 parked, 3 queued, 4 in flight, 4 need you, 2 landed today.");

  const empty = (await overview(fixture({ empty: true }).sources)).airspace;
  expect(empty.planes).toEqual([]);
  expect(empty.landed.count).toBe(0);
});

/** Mark an existing mission plan-approved and waiting for the build slot (LOOP-61). */
function makeReady(f: Fixture, id: string) {
  f.sources.db.run(
    "UPDATE missions SET data = ? WHERE intent = ? AND stage NOT IN ('done','stopped')",
    JSON.stringify({ ready: 1 }),
    id,
  );
}

test("ui: ready to build shows behind the running intent", async () => {
  const f = fixture();
  const before = await overview(f.sources);
  expect(before.needs.some((c) => c.intent === IDS.plan)).toBe(true);
  makeReady(f, IDS.plan);
  const o = await overview(f.sources);
  expect(o.needs.some((c) => c.intent === IDS.plan)).toBe(false);
  const row = o.queued.find((r) => r.intent === IDS.plan)!;
  expect(row.state).toMatchObject({ key: "queued", label: "Queued" });
  expect(row.step).toBe("Ready to build");
  expect(row.behind).toMatch(
    /^Ready to build, behind “.+”\.$|^Ready to build; it starts on the next pass\.$/,
  );
  expect(o.working.some((r) => r.intent === IDS.plan)).toBe(false);
  expect(o.airspace.planes.find((p) => p.intent === IDS.plan)).toMatchObject({ station: "code" });
  // The intent page doesn't ask the owner for anything.
  const page = (await intentPage(f.sources, IDS.plan))!;
  expect(page.card).toBeNull();
  expect(page.state.label).toBe("Queued");
});

test("ui: queue lane shows ahead count", async () => {
  const f = fixture();
  const lane = async (repo: string) => (await queue(f.sources)).lanes.find((l) => l.repo === repo)!;
  const before = await lane("api");
  expect(before.ahead).toMatch(/^\d+ of 3 ahead$/);
  const n = Number(before.ahead.split(" ")[0]);
  expect(n).toBeGreaterThan(0);
  makeReady(f, IDS.plan);
  const after = await lane("api");
  expect(after.ahead).toBe(`${n - 1} of 3 ahead`);
  // The slot's holder first, then the plan-approved intent, then those ahead.
  const order = after.running.map((r) => r.intent);
  expect(order.indexOf(IDS.plan)).toBeGreaterThan(-1);
  expect(after.running.filter((r) => r.behind !== null).map((r) => r.intent)).toEqual([IDS.plan]);
});

test("ui: start now appears only for an unstarted intent", async () => {
  const f = fixture();
  const o = await overview(f.sources);
  expect(o.upNext.find((u) => u.intent === IDS.upnext)!.canStart).toBe(true);
  expect(o.upNext.find((u) => u.intent === IDS.queued)!.canStart).toBe(true);
  expect(o.upNext.find((u) => u.intent === IDS.parked2)!.canStart).toBe(false);
  expect(o.airspace.planes.find((p) => p.intent === IDS.upnext)!.canStart).toBe(true);
  expect(o.airspace.planes.find((p) => p.intent === IDS.plan)!.canStart).toBe(false);
  expect((await intentPage(f.sources, IDS.upnext))!.canStart).toBe(true);
  expect((await intentPage(f.sources, IDS.plan))!.canStart).toBe(false);
  expect((await intentPage(f.sources, IDS.parked2))!.canStart).toBe(false);
  f.state.running = false;
  expect((await intentPage(f.sources, IDS.upnext))!.canStart).toBe(false);
  expect((await overview(f.sources)).upNext[0]!.canStart).toBe(false);
});
