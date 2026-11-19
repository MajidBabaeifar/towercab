// UI-165..167: the parts of a multi-repo intent, its freeze, the Board and the API carry them.

import { afterEach, expect, test } from "vitest";
import { takeFreeze } from "../../src/freeze.ts";
import { dataOf, forIntent, type Mission } from "../../src/mission.ts";
import { seedParts } from "../../src/parts.ts";
import { board } from "../../src/ui/board.ts";
import { intentPage, overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: Fixture[] = [];
afterEach(() => {
  while (open.length) open.pop()!.cleanup();
});
function fixture(): Fixture {
  const f = buildFixture({ now: NOW });
  open.push(f);
  return f;
}

/** The newest mission of the intent, made a two-part one (infra first, then web) with `patch` on its row. */
function multi(
  f: Fixture,
  intent: string,
  o: { stage?: string; waiting?: string | null; from?: string | null; why?: string | null } = {},
  parts?: (p: ReturnType<typeof seedParts>) => ReturnType<typeof seedParts>,
): Mission {
  const m = forIntent(f.db, intent).at(-1)!;
  const seeded = seedParts(
    [
      { repo: "infra", waitsOn: [] },
      { repo: "web", waitsOn: ["infra"] },
    ],
    m,
  );
  const list = (parts ?? ((p) => p))(seeded);
  f.db.run("UPDATE missions SET data = ? WHERE id = ?", JSON.stringify({ ...dataOf(m), parts: list }), m.id);
  if (o.stage) {
    f.db.run(
      "UPDATE missions SET stage = ?, waiting = ?, from_stage = ?, why = ? WHERE id = ?",
      o.stage,
      o.waiting ?? null,
      o.from ?? null,
      o.why ?? null,
      m.id,
    );
  }
  return forIntent(f.db, intent).at(-1)!;
}

test("ui: a multi-repo intent lists a part per repo", async () => {
  const f = fixture();
  multi(f, IDS.ci, {}, (p) => p.map((x, i) => ({ ...x, pr: 7 + i })));
  const page = (await intentPage(f.sources, IDS.ci))!;
  expect(page.parts!.map((p) => [p.repo, p.pr])).toEqual([
    ["infra", 7],
    ["web", 8],
  ]);
  expect(page.parts![0]!.prUrl).toMatch(/\/pull\/7$/);
});

test("ui: a part says what it waits on", async () => {
  const f = fixture();
  multi(f, IDS.ci, { stage: "merge", why: "waiting for the freeze of infra" }, (p) =>
    p.map((x) => ({ ...x, atGate: true })),
  );
  let page = (await intentPage(f.sources, IDS.ci))!;
  expect(page.parts!.map((p) => p.waiting)).toEqual(["the freeze of infra", "the freeze of infra"]);
  multi(f, IDS.ci, { stage: "merge", why: null }, (p) => p.map((x) => ({ ...x, atGate: true })));
  page = (await intentPage(f.sources, IDS.ci))!;
  expect(page.parts!.map((p) => p.waiting)).toEqual([null, "the part it merges after (infra)"]);
  multi(f, IDS.ci, { stage: "ci" }, (p) => p.map((x) => ({ ...x, stage: "ci" as const })));
  page = (await intentPage(f.sources, IDS.ci))!;
  expect(page.parts!.map((p) => p.waiting)).toEqual(["a check", "a check"]);
  multi(f, IDS.ci, { stage: "ci" }, (p) =>
    p.map((x, i) => (i === 0 ? { ...x, waiting: "answer the question" } : x)),
  );
  page = (await intentPage(f.sources, IDS.ci))!;
  expect(page.parts![0]!.waiting).toBe("your answer");
});

test("ui: the page shows the freeze and its age", async () => {
  const f = fixture();
  const m = multi(f, IDS.ci, { stage: "merge" });
  takeFreeze(f.db, m.id, ["infra", "web"], NOW - 3600);
  const page = (await intentPage(f.sources, IDS.ci))!;
  expect(page.freeze).toBe("Merges frozen in infra, web for 1 h 00 min (limit 2 h 00 min)");
});

test("ui: a single-repo intent has no parts list", async () => {
  const f = fixture();
  const page = (await intentPage(f.sources, IDS.ci))!;
  expect(page.parts).toBeUndefined();
  expect(page.freeze).toBeUndefined();
  const o = await overview(f.sources);
  expect(o.working.find((r) => r.intent === IDS.ci)!.repoCount).toBeUndefined();
});

test("ui: a multi-repo card shows the repo count and the slowest part", async () => {
  const f = fixture();
  multi(f, IDS.ci, { stage: "ci" }, (p) =>
    p.map((x, i) => (i === 0 ? { ...x, stage: "review" as const } : { ...x, stage: "ci" as const })),
  );
  const row = (await overview(f.sources)).working.find((r) => r.intent === IDS.ci)!;
  expect(row.repoCount).toBe("2 repos");
  expect(row.slowest).toBe("web: waiting for checks");
  const card = (await board(f.sources)).repos
    .flatMap((r) => Object.values(r.cells).flat())
    .find((c) => c?.intent === IDS.ci)!;
  expect(card.repoCount).toBe("2 repos");
});

test("ui: a frozen repo is marked on the Board", async () => {
  const f = fixture();
  const m = multi(f, IDS.ci, { stage: "merge" });
  takeFreeze(f.db, m.id, ["infra", "web"], NOW);
  const b = await board(f.sources);
  expect(b.repos.find((r) => r.repo === "web")!.frozen).toBe("Merges frozen for Faster checkout page");
  expect(b.repos.find((r) => r.repo === "infra")!.frozen).toBe("Merges frozen for Faster checkout page");
  expect(b.repos.find((r) => r.repo === "api")!.frozen).toBeUndefined();
});

test("ui: an intent held by a freeze says so", async () => {
  const f = fixture();
  const m = multi(f, IDS.ci, { stage: "merge" });
  takeFreeze(f.db, m.id, ["web"], NOW);
  // Another intent of the repo waits at its merge.
  const other = forIntent(f.db, IDS.building).at(-1)!;
  f.db.run("UPDATE missions SET stage = 'merge', repo = 'web' WHERE id = ?", other.id);
  const o = await overview(f.sources);
  const row = [...o.working, ...o.queued].find((r) => r.intent === IDS.building)!;
  expect(row.freezeHold).toBe("waiting for the freeze");
  const card = (await board(f.sources)).repos
    .flatMap((r) => Object.values(r.cells).flat())
    .find((c) => c?.intent === IDS.building)!;
  expect(card.freezeHold).toBe("waiting for the freeze");
});

const needs = async (f: Fixture, intent: string) =>
  (await overview(f.sources)).needs.find((c) => c.intent === intent)!;

test("ui: a freeze past its limit offers keep waiting and unfreeze", async () => {
  const f = fixture();
  multi(f, IDS.ci, { stage: "blocked", waiting: "freeze", from: "merge", why: "Merges have been frozen." });
  const card = await needs(f, IDS.ci);
  expect(card.exits.map((e) => e.label)).toEqual(["Keep waiting", "Unfreeze", "Drop"]);
  expect(card.exits.map((e) => e.do)).toEqual(["continue", "unfreeze", "drop"]);
});

test("ui: unfreeze confirms when a part is merged", async () => {
  const f = fixture();
  multi(f, IDS.ci, { stage: "blocked", waiting: "freeze", from: "merge" });
  expect((await needs(f, IDS.ci)).exits.find((e) => e.do === "unfreeze")!.confirm).toBeUndefined();
  multi(f, IDS.ci, { stage: "blocked", waiting: "freeze", from: "merge" }, (p) =>
    p.map((x, i) => (i === 0 ? { ...x, merged: true } : x)),
  );
  const unfreeze = (await needs(f, IDS.ci)).exits.find((e) => e.do === "unfreeze")!;
  expect(unfreeze.confirm).toBe(
    "A part is already merged: the intent will end as merged, not verified live.",
  );
});

test("ui: a lifted freeze waits for the freeze again button", async () => {
  const f = fixture();
  multi(f, IDS.ci, { stage: "blocked", waiting: "freeze lifted", from: "merge" });
  const card = await needs(f, IDS.ci);
  expect(card.exits.map((e) => e.label)).toEqual(["Freeze again", "Drop"]);
  expect(card.ask).toContain("Merges are unpaused");
});

test("ui: the unverified card lists merged and unmerged parts with a retry", async () => {
  const f = fixture();
  const m = multi(f, IDS.ci, { stage: "unverified" }, (p) =>
    p.map((x, i) => (i === 0 ? { ...x, merged: true, pr: 4 } : x)),
  );
  f.db.run("UPDATE missions SET finished = ? WHERE id = ?", NOW, m.id);
  const page = (await intentPage(f.sources, IDS.ci))!;
  expect(page.parts!.map((p) => [p.repo, p.merged])).toEqual([
    ["infra", true],
    ["web", false],
  ]);
  expect(page.rest!.text).toBe(
    "Merged, not verified live. Merged: infra. Not merged: web. Nothing was rolled back.",
  );
  expect(page.rest!.action).toEqual({ do: "retry", label: "Land the rest" });
});

test("ui: parts and frozen repos come from the API", async () => {
  const f = fixture();
  const m = multi(f, IDS.ci, { stage: "merge" });
  takeFreeze(f.db, m.id, ["infra"], NOW);
  const o = JSON.parse(JSON.stringify(await overview(f.sources))) as Awaited<ReturnType<typeof overview>>;
  const row = o.working.find((r) => r.intent === IDS.ci)!;
  expect(row.parts!.map((p) => Object.keys(p).sort())[0]).toEqual(
    expect.arrayContaining(["merged", "pr", "repo", "stage", "waitsOn"]),
  );
  expect(o.airspace.repos!.find((r) => r.repo === "infra")!.frozenBy).toBe(m.id);
  expect(o.airspace.repos!.find((r) => r.repo === "web")!.frozenBy).toBeNull();
});
