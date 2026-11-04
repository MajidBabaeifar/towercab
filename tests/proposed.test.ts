// INT-51 to INT-53, LOOP-92, LOOP-93: the proposed intents, read from the intents repo's open PRs.

import { join } from "node:path";
import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { MORE_THAN_FILE, MORE_THAN_ONE, type ProposedPr, readProposed } from "../src/github/proposed.ts";
import type { GitHub } from "../src/handlers.ts";
import { Home } from "../src/home.ts";
import { Loop } from "../src/loop.ts";
import { createActions } from "../src/ui/actions.ts";
import { MemStore } from "../ui/fixture.ts";
import { intent } from "./helpers/flows.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { TestClock, tempDir } from "./helpers/world.ts";

const REPO = "acme/intents";
const NEW = "intents/261101-0900-1-x/intent.md";

interface FakePr {
  number: number;
  title?: string;
  draft?: boolean;
  author?: string;
  head?: string;
  files: [string, string][];
  text?: string;
  state?: string;
}

/** The intents repo as `gh` sees it: open PRs with their files and the intent text. */
function world(prs: FakePr[]) {
  const tools = new FakeTools();
  const calls: string[] = [];
  const h = (p: FakePr) => p.head ?? `h${p.number}`.padEnd(40, "0");
  tools.on("gh", (raw) => {
    const args = raw[0] === "--as-owner" ? raw.slice(1) : raw;
    calls.push(args.join(" "));
    const [a, b] = args;
    const n = Number(args[2]);
    const pr = prs.find((p) => p.number === n);
    if (a === "pr" && b === "list") {
      return okResult(
        JSON.stringify(
          prs
            .filter((p) => (p.state ?? "OPEN") === "OPEN")
            .map((p) => ({
              number: p.number,
              title: p.title ?? "Intent: x",
              isDraft: p.draft ?? false,
              author: { login: p.author ?? "majid" },
              createdAt: "2026-11-01T09:00:00Z",
              headRefOid: h(p),
              url: `https://github.com/${REPO}/pull/${p.number}`,
            })),
        ),
      );
    }
    if (a === "pr" && b === "view" && pr) {
      return okResult(
        JSON.stringify({ state: pr.state ?? "OPEN", isDraft: pr.draft ?? false, headRefOid: h(pr) }),
      );
    }
    if (a === "pr" && (b === "ready" || b === "merge" || b === "close") && pr) {
      if (b === "merge" && pr.state === "MERGED") return failResult("already merged");
      if (b === "merge") pr.state = "MERGED";
      if (b === "close") pr.state = "CLOSED";
      if (b === "ready") pr.draft = false;
      return okResult();
    }
    if (a === "api") {
      const path = args.find((x) => x.startsWith("repos/")) ?? "";
      const files = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/files/.exec(path);
      if (files) {
        const p = prs.find((x) => x.number === Number(files[1]));
        return okResult(JSON.stringify((p?.files ?? []).map(([filename, status]) => ({ filename, status }))));
      }
      const contents = /^repos\/[^/]+\/[^/]+\/contents\/.+\?ref=(.+)$/.exec(path);
      if (contents) {
        const p = prs.find((x) => h(x) === contents[1]);
        return okResult(p?.text ?? intent({ title: "Export invoices", repo: "web", u: 4, i: 5 }));
      }
    }
    return failResult(`fake gh: unhandled ${args.join(" ")}`);
  });
  const github: GitHub = {
    me: "owner",
    gh: (_repo, args, opts) => tools.run("gh", args, opts),
    owner: (args, opts) => tools.run("gh", ["--as-owner", ...args], opts),
    gitAuth: async () => ({ args: [], env: {} }),
    bot: async () => ({ login: "towercab", id: 9, email: "9+towercab@users.noreply.github.com" }),
  };
  return { tools, github, calls, prs, read: () => readProposed(github, REPO, new Map(), "towercab") };
}

const adds = (path = NEW): [string, string][] => [[path, "added"]];

test("proposed: a PR that adds one intent is proposed", async () => {
  const w = world([{ number: 7, files: [...adds(), ["TODO.md", "modified"]] }]);
  const [p] = await w.read();
  expect(p).toMatchObject({
    number: 7,
    url: `https://github.com/${REPO}/pull/7`,
    acceptable: true,
    reason: null,
    path: NEW,
    textUrl: `https://github.com/${REPO}/blob/${"h7".padEnd(40, "0")}/${NEW}`,
    intent: { title: "Export invoices", repo: "web", u: 4, i: 5, a: 5, source: "me" },
  });
});

test("proposed: drafts are proposed too", async () => {
  const w = world([{ number: 8, draft: true, files: adds() }]);
  expect((await w.read()).map((p) => [p.number, p.draft])).toEqual([[8, true]]);
});

test("proposed: plan PRs and other PRs are not", async () => {
  const w = world([
    { number: 1, files: [["intents/261101-0900-1-x/intent.md", "modified"]] },
    { number: 2, files: [["intents/261101-0900-1-x/plan.md", "added"]] },
    { number: 3, files: [["README.md", "modified"]] },
    { number: 4, files: adds() },
  ]);
  expect((await w.read()).map((p) => p.number)).toEqual([4]);
});

test("proposed: a PR with several intents or other files is GitHub only", async () => {
  const w = world([
    { number: 1, files: [...adds(), ...adds("intents/261101-0900-2-y/intent.md")] },
    { number: 2, files: [...adds(), ["src/app.ts", "modified"]] },
  ]);
  const got = await w.read();
  expect(got.map((p) => [p.number, p.acceptable, p.reason])).toEqual([
    [1, false, MORE_THAN_ONE],
    [2, false, MORE_THAN_FILE],
  ]);
});

test("proposed: an unreadable intent file is shown with its reason", async () => {
  const w = world([{ number: 5, files: adds(), text: "---\nu: 4\n---\n\n# Intent: no repo\n" }]);
  const [p] = await w.read();
  expect(p).toMatchObject({ number: 5, acceptable: false, intent: null });
  expect(p!.reason).toContain("repo is missing");
});

test("proposed: priority and parked follow the scores", async () => {
  // The numbers come from PRI-3 and the cutoff of the loop's config (UI-184).
  const { proposedSection } = await import("../src/ui/proposed.ts");
  const { buildFixture } = await import("../ui/fixture.ts");
  const f = buildFixture({ proposed: true });
  try {
    const cards = proposedSection(f.sources).cards;
    const by = (n: number) => cards.find((c) => c.pr === n)!;
    expect([by(201).priority, by(201).priorityText]).toEqual([14, "priority 14"]);
    expect([by(203).priority, by(203).priorityText, by(203).parked]).toEqual([5, "would be parked", true]);
  } finally {
    f.cleanup();
  }
});

test("proposed: the proposer is the PR author", async () => {
  const w = world([
    { number: 1, author: "majid", files: adds() },
    { number: 2, author: "towercab", files: adds("intents/261101-0900-2-y/intent.md") },
  ]);
  expect((await w.read()).map((p) => p.proposer)).toEqual(["majid", "Towercab"]);
});

function actions(w: ReturnType<typeof world>, listed: ProposedPr[] = []) {
  const db = Db.memory();
  const store = new MemStore();
  store.repo = REPO;
  const a = createActions({
    db,
    store,
    config: parseConfig({ intents: { remote: "/x" }, repos: { web: { github: "acme/web" } } }, "/x/c.toml"),
    clock: new TestClock(),
    github: w.github,
    proposed: () => listed,
  });
  return { a, db };
}

const head = (n: number) => `h${n}`.padEnd(40, "0");

test("proposed: accept marks a draft ready and squash-merges", async () => {
  const w = world([{ number: 9, draft: true, files: adds() }]);
  const { a, db } = actions(w);
  expect(await a.accept(9, head(9))).toContain("Merged PR #9");
  const lines = w.calls.filter((l) => /^pr (ready|merge)/.test(l));
  expect(lines[0]).toBe(`pr ready 9 -R ${REPO}`);
  expect(lines[1]).toBe(`pr merge 9 --squash --match-head-commit ${head(9)} -R ${REPO}`);
  expect(w.tools.calls.filter((c) => c.args[0] === "--as-owner")).not.toHaveLength(0);
  expect(db.meta("proposed:poll")).toBe("1");
});

test("proposed: accept refuses a PR that changed", async () => {
  const w = world([{ number: 9, files: adds() }]);
  const { a } = actions(w);
  await expect(a.accept(9, "0".repeat(40))).rejects.toThrow(
    "PR #9 changed since you looked: check it and try again",
  );
  w.prs[0]!.state = "CLOSED";
  await expect(a.accept(9, head(9))).rejects.toThrow("changed since you looked");
  expect(w.calls.some((l) => l.startsWith("pr merge"))).toBe(false);
});

test("proposed: close comments the reason and closes", async () => {
  const w = world([{ number: 9, files: adds() }]);
  const { a } = actions(w);
  await a.close(9, "Duplicate of another intent.");
  expect(w.calls.find((l) => l.startsWith("pr close"))).toBe(
    `pr close 9 -R ${REPO} --comment Duplicate of another intent.`,
  );
  const again = await a.close(9);
  expect(again).toContain("already closed");
  const w2 = world([{ number: 4, files: adds() }]);
  await actions(w2).a.close(4);
  expect(w2.calls.find((l) => l.startsWith("pr close"))).toContain("--comment Not going ahead.");
});

test("proposed: GitHub-only PRs can't be accepted", async () => {
  const w = world([{ number: 9, files: [...adds(), ["src/app.ts", "modified"]] }]);
  await expect(actions(w).a.accept(9, head(9))).rejects.toThrow("changed since you looked");
  expect(w.calls.some((l) => l.startsWith("pr merge") || l.startsWith("pr ready"))).toBe(false);
});

test("proposed: GitHub-only PRs can be closed", async () => {
  const w = world([{ number: 9, files: [...adds(), ...adds("intents/261101-0900-2-y/intent.md")] }]);
  await actions(w).a.close(9);
  expect(w.prs[0]!.state).toBe("CLOSED");
});

/** A loop over the in-memory store whose proposed list the test sets. */
function loopWorld(o: { port?: number } = {}) {
  const db = Db.memory();
  const clock = new TestClock();
  const home = new Home(tempDir("tc-home-"));
  const config = parseConfig(
    {
      intents: { remote: "/x" },
      repos: { web: { github: "acme/web" } },
      ui: { port: o.port ?? 7311 },
    },
    join(home.root, "config.toml"),
  );
  const store = new MemStore();
  store.repo = REPO;
  const sent: string[] = [];
  const sender = {
    async send(text: string) {
      sent.push(text);
    },
  };
  const state = { list: [] as ProposedPr[], reads: 0, fail: null as string | null };
  const loop = new Loop(
    {
      config,
      home,
      db,
      tools: new FakeTools(),
      clock,
      store,
      github: world([]).github,
      handlers: {},
      log: () => {},
      sender,
      readProposed: async () => {
        state.reads++;
        if (state.fail) throw new Error(state.fail);
        return state.list;
      },
    },
    { watch: true },
  );
  return { db, clock, loop, state, sent };
}

function pr(n: number, p: Partial<ProposedPr> = {}): ProposedPr {
  return {
    number: n,
    url: `https://github.com/${REPO}/pull/${n}`,
    title: `Intent: T${n}`,
    draft: false,
    proposer: "majid",
    createdAt: 1_792_000_000,
    head: head(n),
    path: NEW,
    intent: { title: `T${n}`, repo: "web", u: 4, i: 5, a: 3, source: "me" },
    textUrl: "https://example.test/x",
    acceptable: true,
    reason: null,
    ...p,
  };
}

test("proposed: the intents PRs are read every minute", async () => {
  const w = loopWorld();
  await w.loop.open();
  expect(w.state.reads).toBe(1);
  await w.loop.pass();
  expect(w.state.reads).toBe(1);
  w.clock.advance(61);
  await w.loop.pass();
  expect(w.state.reads).toBe(2);
  // The page acted on a PR: read at once.
  w.db.setMeta("proposed:poll", "1");
  await w.loop.pass();
  expect(w.state.reads).toBe(3);
  expect(w.db.meta("proposed:poll")).toBeNull();
});

test("proposed: a gh failure is a github fault and keeps the last list", async () => {
  const w = loopWorld();
  w.state.list = [pr(1)];
  await w.loop.open();
  expect(w.loop.proposedState().list.map((p) => p.number)).toEqual([1]);
  w.state.fail = "gh pr list: HTTP 502";
  w.clock.advance(61);
  await w.loop.pass();
  const s = w.loop.proposedState();
  expect(s.list.map((p) => p.number)).toEqual([1]);
  expect(s.error).toContain("HTTP 502");
  expect(w.loop.health.open().map((f) => f.kind)).toContain("github");
  w.state.fail = null;
  w.clock.advance(61);
  await w.loop.pass();
  expect(w.loop.proposedState().error).toBeNull();
  expect(w.loop.health.open().map((f) => f.kind)).not.toContain("github");
});

/** Open, then a first read with `first` already open (seeded, no messages). */
async function seeded(first: ProposedPr[] = []) {
  const w = loopWorld();
  w.state.list = first;
  await w.loop.open();
  await w.loop.pass();
  return w;
}

test("proposed: a new proposal sends one message", async () => {
  const w = await seeded();
  w.state.list = [pr(3), pr(4, { intent: { title: "T4", repo: "web", u: 1, i: 1, a: 3, source: "me" } })];
  w.clock.advance(61);
  await w.loop.pass();
  expect(w.sent).toEqual([
    "Proposed intent: T3 (web), priority 14\nhttp://localhost:7311/#proposed-3",
    "Proposed intent: T4 (web), would be parked\nhttp://localhost:7311/#proposed-4",
  ]);
});

test("proposed: the same PR never sends twice", async () => {
  const w = await seeded();
  const gh = pr(3, { acceptable: false, reason: MORE_THAN_ONE });
  w.state.list = [gh];
  w.clock.advance(61);
  await w.loop.pass();
  // Changed, left draft, and a restart: nothing more.
  w.state.list = [{ ...gh, draft: true, head: head(30) }];
  w.clock.advance(61);
  await w.loop.pass();
  expect(w.sent).toEqual(["Proposed intent: T3 (web), priority 14\nhttps://github.com/acme/intents/pull/3"]);
  const rows = w.db.all<{ key: string }>("SELECT key FROM outbox");
  expect(rows.map((r) => r.key)).toEqual(["proposed:3"]);
  const again = new Loop(w.loop.d, { watch: true });
  await again.open();
  await again.pass();
  expect(w.sent).toHaveLength(1);
});

test("proposed: a proposal closed before sending is dropped", async () => {
  const w = await seeded();
  w.state.list = [pr(3)];
  // The message can't go yet: the sender fails.
  let up = false;
  const real = w.loop.d.sender!;
  (w.loop.d as { sender: typeof real }).sender = {
    send: async (t) => {
      if (!up) throw new Error("telegram down");
      await real.send(t);
    },
  };
  w.clock.advance(61);
  await w.loop.pass();
  expect(w.sent).toEqual([]);
  // The PR is closed on GitHub; the next read no longer lists it.
  w.state.list = [];
  up = true;
  w.clock.advance(61);
  await w.loop.pass();
  await w.loop.pass();
  expect(w.sent).toEqual([]);
  expect(w.db.get<{ sent_at: number }>("SELECT sent_at FROM outbox WHERE key = 'proposed:3'")?.sent_at).toBe(
    0,
  );
});

test("proposed: proposals already open on the first read send nothing", async () => {
  const w = await seeded([pr(1), pr(2)]);
  expect(w.sent).toEqual([]);
  expect(w.db.meta("proposed:seeded")).not.toBeNull();
  expect(w.db.meta("proposed:seen:1")).not.toBeNull();
  w.clock.advance(61);
  await w.loop.pass();
  expect(w.sent).toEqual([]);
  w.state.list = [pr(1), pr(2), pr(5)];
  w.clock.advance(61);
  await w.loop.pass();
  expect(w.sent).toHaveLength(1);
});
