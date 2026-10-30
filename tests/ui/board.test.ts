// UI-133 to UI-137: the board's columns and rows, what it shows as done, and spend per repo.

import { afterEach, expect, test } from "vitest";
import { Db } from "../../src/db.ts";
import { board } from "../../src/ui/board.ts";
import { repoSpend, spendByRepo, spendTotals } from "../../src/ui/spend.ts";
import { overview, spend } from "../../src/ui/state.ts";
import type { BoardColumnKey } from "../../src/ui/view.ts";
import { buildFixture, type Fixture, IDS, makeIntent } from "../../ui/fixture.ts";

// Mon 26 Oct 2026, 23:00:00 local time.
const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const DAY = 86_400;
const open: Fixture[] = [];
afterEach(() => {
  while (open.length) open.pop()!.cleanup();
});
function fixture(): Fixture {
  const f = buildFixture({ now: NOW });
  open.push(f);
  return f;
}

/** Every card as `intent → [repo, column]`. */
function placed(b: Awaited<ReturnType<typeof board>>): Record<string, [string, BoardColumnKey]> {
  const out: Record<string, [string, BoardColumnKey]> = {};
  for (const r of b.repos) {
    for (const [k, cards] of Object.entries(r.cells)) {
      for (const c of cards ?? []) out[c.intent] = [r.repo, k as BoardColumnKey];
    }
  }
  return out;
}

test("ui: board columns follow the airspace", async () => {
  const f = fixture();
  const b = await board(f.sources);
  expect(b.columns.map((c) => c.label)).toEqual([
    "Queue",
    "Gate",
    "Spec",
    "Your spec review",
    "Plan",
    "Your plan review",
    "Code",
    "CI",
    "Your code review",
    "Done",
  ]);
  expect(b.columns.map((c) => c.count)).toEqual([4, 2, 0, 0, 0, 1, 4, 1, 1, 5]);
  // Config order, then a repo only an intent names.
  expect(b.repos.map((r) => r.repo)).toEqual(["web", "api", "docs", "mobile", "infra", "blog", "crm"]);
  expect(b.repos.find((r) => r.repo === "crm")!.github).toBe("");

  // Every plane sits in the column of its station; parked ones in Queue.
  const at = placed(b);
  const planes = (await overview(f.sources)).airspace.planes;
  for (const p of planes) {
    expect(at[p.intent], p.intent).toEqual([p.repo, p.station === "parked" ? "queue" : p.station]);
  }
  // Parked below the queued ones, each with its own chip; cards carry the plane's state.
  const web = b.repos.find((r) => r.repo === "web")!;
  expect(web.cells.queue!.map((c) => [c.title, c.state.label])).toEqual([
    ["Dark mode for the settings page", "Queued"],
    ["Try a new chart library", "Parked"],
  ]);
  expect(web.cells.ci).toEqual([
    {
      intent: IDS.ci,
      title: "Faster checkout page",
      state: planes.find((p) => p.intent === IDS.ci)!.state,
    },
  ]);
  expect([web.open, web.done]).toEqual([4, 2]);

  // With a deploy in the last week the ship columns join, before Done, as on the airspace.
  const id = f.db.get<{ id: number }>("SELECT max(id) AS id FROM missions WHERE intent = ?", IDS.code)!.id;
  f.db.run("UPDATE missions SET stage = 'e2e' WHERE id = ?", id);
  const shipping = await board(f.sources);
  expect(shipping.columns.map((c) => c.key).slice(-3)).toEqual(["deploy", "e2e", "done"]);
  expect(placed(shipping)[IDS.code]).toEqual(["docs", "e2e"]);
});

test("ui: board shows what was done in the last 7 days", async () => {
  const f = fixture();
  f.store.done.push(
    makeIntent({
      id: "261018-1000-1",
      title: "Old work",
      repo: "web",
      done: true,
      stage: "done",
      finished: new Date((NOW - 8 * DAY) * 1000).toISOString(),
    }),
  );
  const b = await board(f.sources);
  const done = b.repos.flatMap((r) => (r.cells.done ?? []).map((c) => [r.repo, c.intent, c.state.note]));
  expect(done).toEqual([
    ["web", IDS.done1, "Sat 21:00"],
    ["web", IDS.done3, "Fri 00:00"],
    ["api", IDS.done2, "20 h ago"],
    ["infra", IDS.done4, "Wed 00:00"],
    ["blog", IDS.landed, "5 h ago"],
  ]);
  // Not the dropped one, nor one done 8 days ago.
  expect(placed(b)[IDS.dropped]).toBeUndefined();
  expect(placed(b)["261018-1000-1"]).toBeUndefined();
  expect(b.repos.find((r) => r.repo === "web")!.cells.done!.every((c) => c.state.key === "done")).toBe(true);
});

function mission(db: Db, o: { repo: string; cost: number; updated: number; runs: unknown }) {
  db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, model, session, checkout, branch, cost_usd, data, created, updated)
     VALUES (?, ?, 1, 'done', 'opus', 's', 'w', 'b', ?, ?, ?, ?)`,
    `i${db.all("SELECT id FROM missions").length}`,
    o.repo,
    o.cost,
    typeof o.runs === "string" ? o.runs : JSON.stringify({ runs: o.runs }),
    o.updated - 3600,
    o.updated,
  );
}

test("ui: spend per repo today, 7 days and all time", async () => {
  const local = (d: number, h: number) => new Date(2026, 9, d, h, 0, 0).getTime() / 1000;
  const db = Db.memory();
  mission(db, {
    repo: "web",
    cost: 6,
    updated: local(26, 20),
    runs: [
      { at: local(26, 9), cost: 1.5 },
      { at: local(25, 10), cost: 2 },
      { at: local(19, 10), cost: 2.5 },
    ],
  });
  mission(db, { repo: "web", cost: 4, updated: local(26, 22), runs: [{ at: local(26, 21), cost: 4 }] });
  // Older than the window: all time only. A bad data column still counts its total.
  mission(db, { repo: "api", cost: 10, updated: local(1, 12), runs: [{ at: local(1, 11), cost: 10 }] });
  mission(db, { repo: "api", cost: 0.5, updated: local(26, 12), runs: "not json" });
  mission(db, { repo: "api", cost: 1, updated: local(24, 12), runs: [{ at: local(24, 11), cost: 1 }] });

  const by = spendByRepo(db, NOW);
  expect(Object.fromEntries(by)).toEqual({
    web: { today: 5.5, week: 7.5, all: 10 },
    api: { today: 0, week: 1, all: 11.5 },
  });
  const total = spendTotals(by);
  expect(total).toEqual({ today: 5.5, week: 8.5, all: 21.5 });
  // The totals agree with the top bar's spend (MET-29).
  expect(total.today).toBeCloseTo(spend(db, NOW).today);
  expect(total.week).toBeCloseTo(spend(db, NOW).week);

  const clock = { now: () => NOW, mono: () => 0 };
  expect(repoSpend({ db, clock }, "web")).toEqual({
    today: "$5.50",
    week: "$7.50",
    all: "$10.00",
    todayUsd: 5.5,
    weekUsd: 7.5,
    allUsd: 10,
  });
  expect(repoSpend({ db, clock }, "nothing-yet").all).toBe("$0.00");

  // The board's rows carry it, and its heading the totals.
  const f = fixture();
  const b = await board(f.sources);
  for (const r of b.repos) expect(r.spend, r.repo).toEqual(repoSpend(f.sources, r.repo));
  expect(b.spend.todayUsd).toBeCloseTo(spend(f.db, NOW).today);
  expect(b.spend.allUsd).toBeCloseTo(f.db.get<{ n: number }>("SELECT SUM(cost_usd) AS n FROM missions")!.n);
});
