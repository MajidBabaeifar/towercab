// UI-184 to UI-188: the proposed intents on the overview, the repo pages and the board.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { UiActions } from "../../src/ui/actions.ts";
import { board } from "../../src/ui/board.ts";
import { repos } from "../../src/ui/repos.ts";
import { startUi, type UiServer } from "../../src/ui/server.ts";
import { clock, overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture } from "../../ui/fixture.ts";
import { tempDir } from "../helpers/world.ts";
import { call, post } from "./http.ts";

const NOW = new Date(2026, 10, 3, 12, 0, 0).getTime() / 1000;
const open: (() => unknown)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

function fixture(): Fixture {
  const f = buildFixture({ now: NOW, proposed: true });
  open.push(() => f.cleanup());
  return f;
}

async function serve(f: Fixture, actions?: UiActions): Promise<{ ui: UiServer; port: number }> {
  const d = tempDir("tc-dist-");
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "index.html"), '<html><head><meta name="towercab-token" content="" /></head></html>');
  const ui = startUi({
    port: 0,
    sources: f.sources,
    actions: actions ?? f.actions,
    distDir: d,
    log: () => {},
  });
  open.push(() => ui.stop());
  return { ui, port: await ui.ready };
}

const numbers = (cards: { pr: number }[]) => cards.map((c) => c.pr);

test("ui: the overview lists proposed intents", async () => {
  const f = fixture();
  const o = await overview(f.sources);
  const c = o.proposed!.cards.find((x) => x.pr === 202)!;
  expect(c).toMatchObject({
    title: "Weekly digest email",
    repo: "api",
    u: 3,
    i: 4,
    a: 3,
    priorityText: "priority 11",
    from: "from majid",
    waiting: "waiting 6 d",
    draft: true,
    prUrl: "https://github.com/acme/intents/pull/202",
    canAccept: true,
  });
  expect(c.textUrl).toContain("/intent.md");
  // Closed or accepted: the page's version moves.
  const before = o.version;
  f.state.proposed = { ...f.state.proposed, list: f.state.proposed.list.slice(1) };
  expect((await overview(f.sources)).version).not.toBe(before);
  // Without proposals the section is empty.
  f.state.proposed = { list: [], error: null, failedAt: null };
  expect((await overview(f.sources)).proposed!.cards).toEqual([]);
});

test("ui: a GitHub-only proposal can be closed but not accepted", async () => {
  const f = fixture();
  const c = (await overview(f.sources)).proposed!.cards.find((x) => x.pr === 204)!;
  expect(c).toMatchObject({ canAccept: false, acceptWhy: "Changes more than one intent" });
  const { ui, port } = await serve(f);
  const r = await post(port, ui.token, { action: "close", pr: 204 });
  expect(r.status).toBe(200);
  expect(f.calls.at(-1)).toEqual({ action: "close", pr: 204 });
  expect(numbers((await overview(f.sources)).proposed!.cards)).not.toContain(204);
});

test("ui: accept merges the proposal and the card goes", async () => {
  const f = fixture();
  const { ui, port } = await serve(f);
  const card = (await overview(f.sources)).proposed!.cards.find((x) => x.pr === 201)!;
  const r = await post(port, ui.token, { action: "accept", pr: 201, head: card.head });
  expect(r.status).toBe(200);
  expect(JSON.parse(r.body).message).toContain("Merged PR #201");
  expect(f.calls.at(-1)).toEqual({ action: "accept", pr: 201, head: card.head });
  expect(numbers((await overview(f.sources)).proposed!.cards)).not.toContain(201);
  // The API needs a pull request number and, for accept, the version the card showed.
  expect((await post(port, ui.token, { action: "accept", pr: 202 })).status).toBe(400);
  expect((await post(port, ui.token, { action: "close" })).status).toBe(400);
  expect((await call(port, { path: "/api/state" })).status).toBe(200);
});

test("ui: close sends the reason", async () => {
  const f = fixture();
  const { ui, port } = await serve(f);
  const r = await post(port, ui.token, { action: "close", pr: 203, text: "Not now." });
  expect(r.status).toBe(200);
  expect(f.calls.at(-1)).toEqual({ action: "close", pr: 203, text: "Not now." });
});

test("ui: a refused accept says why", async () => {
  const f = fixture();
  const refusing: UiActions = {
    ...f.actions,
    accept: async (pr) => {
      throw new Error(`PR #${pr} changed since you looked: check it and try again`);
    },
  };
  const { ui, port } = await serve(f, refusing);
  const r = await post(port, ui.token, { action: "accept", pr: 201, head: "a".repeat(40) });
  expect(r.status).toBe(422);
  expect(JSON.parse(r.body)).toEqual({
    ok: false,
    message: "PR #201 changed since you looked: check it and try again",
  });
  // The card stays.
  expect(numbers((await overview(f.sources)).proposed!.cards)).toContain(201);
});

test("ui: a repo page lists its proposed intents", async () => {
  const f = fixture();
  const web = (await repos(f.sources, "web")).repo!;
  expect(numbers(web.proposed.cards)).toEqual([201, 203]);
  const docs = (await repos(f.sources, "docs")).repo!;
  expect(numbers(docs.proposed.cards)).toEqual([204]);
  expect((await repos(f.sources, "blog")).repo!.proposed.cards).toEqual([]);
});

test("ui: a proposal for an unknown repo shows on the overview only", async () => {
  const f = fixture();
  expect(numbers((await overview(f.sources)).proposed!.cards)).toContain(205);
  for (const r of ["web", "api", "docs", "mobile", "infra", "blog"]) {
    expect(numbers((await repos(f.sources, r)).repo!.proposed.cards)).not.toContain(205);
  }
});

test("ui: the board counts proposed intents", async () => {
  const f = fixture();
  const b = await board(f.sources);
  expect(b.proposed).toBe(5);
  const per = Object.fromEntries(b.repos.filter((r) => r.proposed).map((r) => [r.repo, r.proposed]));
  // The unknown-repo proposal counts in the "" row.
  expect(per).toEqual({ web: 2, api: 1, docs: 1, "": 1 });
  f.state.proposed = { list: [], error: null, failedAt: null };
  const none = await board(f.sources);
  expect([none.proposed, none.repos.some((r) => r.proposed > 0)]).toEqual([0, false]);
});

test("ui: proposed intents are sorted by priority", async () => {
  const f = fixture();
  // 201: 14, 205: 12, 202: 11, 204: 9, 203 would be parked.
  expect(numbers((await overview(f.sources)).proposed!.cards)).toEqual([201, 205, 202, 204, 203]);
  // Equal priorities: the older PR first.
  const list = f.state.proposed.list.map((p) =>
    p.number === 202 ? { ...p, intent: { ...p.intent!, u: 4, i: 5 }, createdAt: NOW - 9 * 86_400 } : p,
  );
  f.state.proposed = { ...f.state.proposed, list };
  expect(numbers((await overview(f.sources)).proposed!.cards).slice(0, 2)).toEqual([202, 201]);
  expect(numbers((await repos(f.sources, "web")).repo!.proposed.cards)).toEqual([201, 203]);
});

test("ui: a failed read says the list may be out of date", async () => {
  const f = fixture();
  const at = NOW - 120;
  f.state.proposed = { ...f.state.proposed, error: "gh pr list: HTTP 502", failedAt: at };
  const o = await overview(f.sources);
  expect(o.proposed!.stale).toBe(`Couldn't reach GitHub at ${clock(at)}: this list may be out of date.`);
  expect(o.proposed!.cards).toHaveLength(5);
  expect(o.proposed!.cards.every((c) => !c.canAccept)).toBe(true);
  expect((await repos(f.sources, "web")).repo!.proposed.stale).toBe(o.proposed!.stale);
});
