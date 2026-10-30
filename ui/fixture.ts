// A fixture home for the page (UI-69): a database and an in-memory intent store with intents in every
// state, served with fake actions. `node ui/fixture.ts [--port N]` serves it for a look.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import type { Clock } from "../src/handlers.ts";
import { Home } from "../src/home.ts";
import type { Intent, IntentStore, Listing, Unreadable } from "../src/intents/types.ts";
import type { Stage } from "../src/machine.ts";
import type { UiActions } from "../src/ui/actions.ts";
import { startUi, type UiServer } from "../src/ui/server.ts";
import { type LogLine, priority, type UiSources, type UpNext } from "../src/ui/state.ts";

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** An intent with defaults for every field. */
export function makeIntent(p: Partial<Intent> & { id: string; title: string; repo: string }): Intent {
  const slug = slugify(p.title);
  const done = p.done ?? false;
  return {
    slug,
    dir: `${done ? "done" : "intents"}/${p.id}-${slug}`,
    done,
    u: null,
    i: null,
    a: null,
    after: [],
    model: null,
    review: null,
    source: "me",
    issue: null,
    started: null,
    unlock: [],
    network: [],
    stage: null,
    waiting: null,
    specPr: null,
    planPr: null,
    pr: null,
    retry: null,
    cost: null,
    agentTime: null,
    attempts: null,
    finished: null,
    lowerWhy: null,
    sections: new Map(),
    text: "",
    ...p,
  };
}

/** An intent store held in memory (read-only). */
export class MemStore implements IntentStore {
  open: Intent[] = [];
  done: Intent[] = [];
  unreadable: Unreadable[] = [];
  dropped = new Set<string>();
  repo = "acme/intents";

  async list(): Promise<Listing> {
    const open = [...this.open].sort((a, b) => priority(b.u, b.i) - priority(a.u, a.i));
    return {
      open,
      done: this.done,
      unreadable: this.unreadable,
      doneIds: new Set(this.done.filter((i) => !this.dropped.has(i.id)).map((i) => i.id)),
      droppedIds: this.dropped,
      head: "0000000",
    };
  }
  async get(id: string): Promise<Intent> {
    const i = [...this.open, ...this.done].find((x) => x.id === id || x.id.endsWith(id));
    if (!i) throw new Error(`no intent ${id}`);
    return i;
  }
  async add(): Promise<Intent> {
    throw new Error("the fixture store is read-only");
  }
  async update(): Promise<Intent> {
    throw new Error("the fixture store is read-only");
  }
  async hasMark(): Promise<boolean> {
    return false;
  }
  async readFile(): Promise<string | null> {
    return null;
  }
  github(): string | null {
    return this.repo;
  }
  url(i: Intent): string | null {
    return `https://github.com/${this.repo}/blob/main/${i.dir}/intent.md`;
  }
}

interface MissionSpec {
  intent: string;
  repo: string;
  stage: Stage;
  from?: Stage;
  waiting?: string;
  why?: string;
  model?: string;
  spec?: number;
  plan?: number;
  pr?: number;
  cost: number;
  agent: number;
  created: number;
  /** [ago seconds, from, event, to, why]. */
  moves: [number, Stage, string, Stage, string?][];
  data?: Record<string, unknown>;
  busy?: boolean;
  limit?: string;
  held?: boolean;
  attempt?: number;
}

function addMission(db: Db, now: number, s: MissionSpec): number {
  const created = now - s.created;
  // The runs that make up the cost, spread over the mission's life (MET-29).
  const runs: { at: number; cost: number }[] = [];
  const n = Math.max(1, s.moves.length);
  for (let k = 0; k < n; k++) {
    const at =
      created +
      ((k + 0.5) / n) * Math.min(s.created, s.created - (s.moves[s.moves.length - 1]?.[0] ?? 0) + 60);
    // Rounded to cents; the last run takes the remainder, so the runs add up to the mission's cost.
    const before = runs.reduce((t, r) => t + r.cost, 0);
    const cost = k === n - 1 ? s.cost - before : s.cost / n;
    runs.push({ at: Math.min(at, now - 30), cost: Math.round(cost * 100) / 100 });
  }
  const finished =
    s.stage === "done" || s.stage === "stopped" ? now - (s.moves[s.moves.length - 1]?.[0] ?? 0) : null;
  const attempt = s.attempt ?? 1;
  const { lastId } = db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, step, from_stage, waiting, why, busy, held, model,
       session, checkout, branch, spec_pr, plan_pr, pr, limit_model, child_kind, child_since, child_model,
       cost_usd, agent_secs, data, created, updated, finished)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.intent,
    s.repo,
    attempt,
    s.stage,
    s.from ?? null,
    s.waiting ?? null,
    s.why ?? null,
    s.busy ? 1 : 0,
    s.held ? 1 : 0,
    s.model ?? "opus",
    `work/${s.intent}-${attempt}`,
    `towercab/${s.intent}`,
    s.spec ?? null,
    s.plan ?? null,
    s.pr ?? null,
    s.limit ?? null,
    s.busy ? "worker" : null,
    s.busy ? now - (s.moves[s.moves.length - 1]?.[0] ?? 0) : null,
    s.busy ? (s.model ?? "opus") : null,
    s.cost,
    s.agent,
    JSON.stringify({ ...(s.data ?? {}), runs }),
    created,
    now - (s.moves[s.moves.length - 1]?.[0] ?? s.created),
    finished,
  );
  for (const [ago, from, event, to, why] of s.moves) {
    db.run(
      "INSERT INTO transitions (mission, at, from_stage, event, to_stage, why) VALUES (?, ?, ?, ?, ?, ?)",
      lastId,
      now - ago,
      from,
      event,
      to,
      why ?? null,
    );
  }
  return lastId;
}

export interface FakeActionCall {
  action: string;
  intent?: string;
  text?: string;
  github?: string;
  name?: string;
}

export interface Fixture {
  root: string;
  home: Home;
  db: Db;
  store: MemStore;
  sources: UiSources;
  actions: UiActions;
  calls: FakeActionCall[];
  state: { paused: boolean; running: boolean; upNext: UpNext[] };
  cleanup(): void;
}

export const IDS = {
  plan: "261025-0910-1",
  question: "261026-0815-2",
  code: "261024-1130-1",
  building: "261026-0700-1",
  ci: "261026-1105-1",
  cooling: "261026-1240-1",
  stalled: "261026-0750-3",
  crm: "261026-1300-1",
  upnext: "261026-0905-1",
  queued: "261025-1610-2",
  queued2: "261025-1720-1",
  parked1: "261020-1015-1",
  parked2: "261019-0940-2",
  done1: "261023-0915-1",
  done2: "261024-1405-1",
  done3: "261021-1600-1",
  done4: "261020-0830-1",
  landed: "261026-0640-1",
  dropped: "261022-1010-1",
} as const;

/** Build the fixture home; `now` defaults to the real clock so relative times read naturally. `empty`
 * gives a home with nothing in it (UI-70). */
export function buildFixture(o: { now?: number; root?: string; empty?: boolean } = {}): Fixture {
  const now = o.now ?? Date.now() / 1000;
  const root = o.root ?? mkdtempSync(join(tmpdir(), "tc-ui-fixture-"));
  const home = new Home(root);
  const db = new Db(home.db);
  const config = parseConfig(
    {
      intents: { remote: "https://github.com/acme/intents.git" },
      agent: { daily_budget_usd: 40 },
      github: { app_id: 1, me: "owner" },
      repos: {
        web: { github: "acme/web", workers: 2 },
        api: { github: "acme/api" },
        docs: { github: "acme/docs", workers: 2 },
        mobile: { github: "acme/mobile" },
        infra: { github: "acme/infra" },
        blog: { github: "acme/blog" },
      },
    },
    join(root, "config.toml"),
  );

  const store = new MemStore();
  if (!o.empty) seed(db, store, home, now);
  const state = {
    paused: false,
    running: true,
    upNext: (o.empty
      ? []
      : [
          { intent: IDS.upnext, priority: 11, skip: null },
          { intent: IDS.queued, priority: 10, skip: { kind: "ahead", n: 3, limit: 3 } },
          { intent: IDS.queued2, priority: 9, skip: { kind: "ahead", n: 3, limit: 3 } },
          { intent: IDS.parked2, priority: 6, skip: { kind: "parked" } },
          { intent: IDS.parked1, priority: 5, skip: { kind: "parked" } },
        ]) as UpNext[],
  };
  const logs: LogLine[] = o.empty
    ? []
    : [
        { at: now - 50 * MIN, text: "github: api.github.com timed out; retrying in 30 s" },
        { at: now - 49 * MIN, text: "github: reachable again" },
        { at: now - 20 * MIN, text: `${IDS.cooling} sonnet hit its usage limit; resets in 67 min` },
        { at: now - 2 * MIN, text: "ui: http://localhost:7311/" },
      ];
  const clock: Clock = {
    now: () => (o.now === undefined ? Date.now() / 1000 : now),
    mono: () => performance.now(),
  };

  const sources: UiSources = {
    db,
    store,
    config,
    clock,
    home,
    get running() {
      return state.running;
    },
    paused: () => state.paused,
    problems: () => [],
    version: () => ({ commit: "3f9c2ab71e0d", behind: 0 }),
    upNext: () =>
      state.paused
        ? state.upNext.map((u) => (u.skip ? u : { ...u, skip: { kind: "paused" } }))
        : state.upNext,
    prUrl: (repo, n) => `https://github.com/${repo}/pull/${n}`,
    intentUrl: (i) => store.url(i),
    logs: () => logs,
  };

  const calls: FakeActionCall[] = [];
  const actions: UiActions = {
    async merge(intent) {
      calls.push({ action: "merge", intent });
      return "Merged the PR as you. Towercab moves on within a minute.";
    },
    async reply(intent, text) {
      calls.push({ action: "reply", intent, text });
      if (!text.trim()) throw new Error("Write a reply first.");
      return "Answer saved to the intent. Towercab goes on with it on its next pass.";
    },
    async retry(intent) {
      calls.push({ action: "retry", intent });
      return "Towercab starts it over on its next pass.";
    },
    async drop(intent) {
      calls.push({ action: "drop", intent });
      return "Towercab drops it on its next pass.";
    },
    async start(intent) {
      calls.push({ action: "start", intent });
      return "Starting its design on the next pass, even if the repo is full.";
    },
    async pause() {
      calls.push({ action: "pause" });
      state.paused = true;
      return "Paused: nothing new starts until you resume.";
    },
    async resume() {
      calls.push({ action: "resume" });
      state.paused = false;
      return "Resumed: Towercab picks up work again.";
    },
    async addRepo(github, name) {
      calls.push({ action: "addRepo", github, ...(name ? { name } : {}) });
      const short = name ?? github.split("/")[1] ?? github;
      return `Adding ${short} (${github}, base main): Towercab is cloning it now. It shows on the Queue page when done, and its intents start from then on.`;
    },
  };

  return {
    root,
    home,
    db,
    store,
    sources,
    actions,
    calls,
    state,
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The fixture's intents, missions and run files. */
function seed(db: Db, store: MemStore, home: Home, now: number): void {
  const sec = (o: Record<string, string>) => new Map(Object.entries(o));
  store.open = [
    makeIntent({
      id: IDS.plan,
      title: "Rate-limit the public API",
      repo: "api",
      u: 4,
      i: 5,
      a: 2,
      stage: "plan",
      waiting: "approve plan",
      sections: sec({
        Why: "A single client sent 40,000 requests in a minute last week and slowed the API down for everyone.",
        Outcome:
          "- Each API key gets at most 600 requests a minute.\n- Over the limit, the API answers 429 with a `Retry-After` header.\n- Limits can be raised per key without a deploy.",
      }),
    }),
    makeIntent({
      id: IDS.question,
      title: "Export invoices as CSV",
      repo: "web",
      u: 4,
      i: 4,
      stage: "code",
      waiting: "answer the question",
      sections: sec({
        Why: "Accountants ask for invoices in a spreadsheet every month; today someone copies them by hand.",
        Outcome: "- An Export button on the invoices page downloads the filtered invoices as CSV.",
        Answers: "- 2026-10-25 16:02: Use the customer's own currency, not USD.",
      }),
    }),
    makeIntent({
      id: IDS.code,
      title: "Rewrite the getting-started guide",
      repo: "docs",
      u: 3,
      i: 4,
      stage: "code",
      waiting: "review and merge PR",
    }),
    makeIntent({
      id: IDS.building,
      title: "Offline mode for the reading list",
      repo: "mobile",
      u: 3,
      i: 5,
      stage: "code",
    }),
    makeIntent({ id: IDS.ci, title: "Faster checkout page", repo: "web", u: 5, i: 4, stage: "code" }),
    makeIntent({
      id: IDS.cooling,
      title: "Search the docs by title",
      repo: "docs",
      u: 3,
      i: 3,
      stage: "code",
      model: "sonnet",
    }),
    makeIntent({
      id: IDS.stalled,
      title: "Rotate log files daily",
      repo: "infra",
      u: 3,
      i: 3,
      stage: "code",
    }),
    makeIntent({
      id: IDS.crm,
      title: "Sync contacts to the CRM",
      repo: "crm",
      u: 2,
      i: 4,
      waiting: "unknown repo",
    }),
    makeIntent({
      id: IDS.upnext,
      title: "Add an RSS feed to the blog",
      repo: "blog",
      u: 3,
      i: 4,
      source: "issue",
      issue: "https://github.com/acme/blog/issues/12",
    }),
    makeIntent({ id: IDS.queued, title: "Dark mode for the settings page", repo: "web", u: 2, i: 4 }),
    makeIntent({ id: IDS.queued2, title: "Translate the docs into German", repo: "docs", u: 3, i: 3 }),
    makeIntent({ id: IDS.parked1, title: "Try a new chart library", repo: "web", u: 1, i: 2 }),
    makeIntent({ id: IDS.parked2, title: "Move CI to self-hosted runners", repo: "infra", u: 2, i: 2 }),
  ];
  const iso = (t: number) => new Date(t * 1000).toISOString();
  // One landing today at any hour: 5 h ago, or halfway since local midnight when that is sooner.
  const midnight = new Date(now * 1000).setHours(0, 0, 0, 0) / 1000;
  const landedToday = now - Math.min(5 * HOUR, (now - midnight) / 2);
  store.done = [
    makeIntent({
      id: IDS.landed,
      title: "Readable CI job names",
      repo: "blog",
      done: true,
      stage: "done",
      cost: 1.9,
      agentTime: 1500,
      attempts: 1,
      finished: iso(landedToday),
    }),
    makeIntent({
      id: IDS.done2,
      title: "Paginate the orders API",
      repo: "api",
      done: true,
      stage: "done",
      cost: 4.8,
      agentTime: 2900,
      attempts: 1,
      finished: iso(now - 20 * HOUR),
    }),
    makeIntent({
      id: IDS.done1,
      title: "Sign in with GitHub",
      repo: "web",
      done: true,
      stage: "done",
      cost: 6.3,
      agentTime: 4100,
      attempts: 2,
      finished: iso(now - 2 * DAY - 3 * HOUR),
    }),
    makeIntent({
      id: IDS.dropped,
      title: "Rewrite the app in Rust",
      repo: "mobile",
      done: true,
      stage: "dropped",
      finished: iso(now - 3 * DAY),
    }),
    makeIntent({
      id: IDS.done3,
      title: "Fix the typo on the pricing page",
      repo: "web",
      done: true,
      stage: "done",
      cost: 2.6,
      agentTime: 600,
      attempts: 1,
      finished: iso(now - 4 * DAY),
    }),
    makeIntent({
      id: IDS.done4,
      title: "Daily backup check",
      repo: "infra",
      done: true,
      stage: "done",
      cost: 3.9,
      agentTime: 2400,
      attempts: 1,
      finished: iso(now - 6 * DAY),
    }),
  ];
  store.dropped.add(IDS.dropped);
  store.unreadable = [
    {
      path: "intents/261025-0815-1-billing-alerts/intent.md",
      reason: "The front matter has no repo: add a line like “repo: web”.",
      id: "261025-0815-1",
    },
  ];

  addMission(db, now, {
    intent: IDS.plan,
    repo: "api",
    stage: "approval:plan",
    from: "plan",
    waiting: "approve plan",
    spec: 118,
    plan: 31,
    cost: 3.42,
    agent: 3100,
    created: 26 * HOUR,
    moves: [
      [26 * HOUR - 20, "pick", "ok", "design"],
      [25 * HOUR, "design", "wait", "approval:spec"],
      [5 * HOUR, "approval:spec", "spec_merged", "plan"],
      [2 * HOUR + 10 * MIN, "plan", "wait", "approval:plan"],
    ],
    data: {
      brief:
        "The plan adds a token-bucket limiter in front of the public routes, keyed by API key, with limits read from `config/limits.toml` so they can change without a deploy. Over the limit the API answers **429** with `Retry-After`.\n\nIt touches the router, adds one middleware and a test suite that drives 700 requests through a fake clock. Nothing changes for internal routes.\n\nThe plan keeps counters in memory per process; with two API processes a key could get up to twice its limit. The spec allows that for now.",
      access: {
        domains: [
          { domain: "redis.io", why: "Read the client's docs for the token bucket script" },
          { domain: "registry.npmjs.org", why: "Install the rate-limiter package" },
        ],
        paths: [{ glob: "config/limits/**", why: "The new per-key limits file" }],
      },
    },
  });
  addMission(db, now, {
    intent: IDS.question,
    repo: "web",
    stage: "blocked",
    from: "build",
    waiting: "answer the question",
    cost: 2.18,
    agent: 2600,
    created: 9 * HOUR,
    moves: [
      [9 * HOUR - 30, "pick", "ok", "design"],
      [8 * HOUR + 50 * MIN, "design", "ok", "plan"],
      [8 * HOUR + 30 * MIN, "plan", "wait", "approval:plan"],
      [6 * HOUR, "approval:plan", "plan_merged", "build"],
      [5 * HOUR, "build", "ok", "verify"],
      [4 * HOUR + 50 * MIN, "verify", "red", "build", "npm test: 2 failing in invoices/export.test.ts"],
      [
        35 * MIN,
        "build",
        "wait",
        "blocked",
        "The invoices table mixes currencies, and the CSV needs one rule for them.",
      ],
    ],
    plan: 28,
    data: {
      question: {
        context:
          "I'm adding the CSV export. Invoices in the same filter can be in different currencies (EUR, USD, GBP), and your earlier answer says to use the customer's own currency. The totals row at the bottom of the CSV can't add up amounts in different currencies.",
        question: "What should the totals row do when the exported invoices are in more than one currency?",
        options: [
          {
            option: "One totals row per currency",
            // biome-ignore lint/suspicious/noThenProperty: the question schema names it so (PIP-41)
            then: "The CSV ends with a row for each currency; nothing is converted.",
          },
          {
            option: "Convert totals to EUR",
            // biome-ignore lint/suspicious/noThenProperty: the question schema names it so (PIP-41)
            then: "One totals row, using the day's ECB rate; the rate is written in the row.",
          },
          {
            option: "No totals row",
            // biome-ignore lint/suspicious/noThenProperty: the question schema names it so (PIP-41)
            then: "The CSV has only invoice rows; spreadsheets add them up.",
          },
        ],
        recommendation:
          "One totals row per currency: accountants can check each row against the bank, and nothing depends on an exchange rate.",
      },
    },
  });
  // The first attempt of the code intent was dropped and started again (UI-76).
  addMission(db, now, {
    intent: IDS.code,
    repo: "docs",
    stage: "stopped",
    spec: 54,
    cost: 1.2,
    agent: 1500,
    created: 4 * DAY,
    moves: [
      [4 * DAY - 30, "pick", "ok", "design"],
      [4 * DAY - 20 * MIN, "design", "wait", "approval:spec"],
      [3 * DAY + 20 * HOUR, "approval:spec", "feedback", "design", "Make the guide shorter."],
      [3 * DAY + 19 * HOUR, "design", "ok", "stopped", "replaced by a fresh attempt"],
    ],
  });
  addMission(db, now, {
    intent: IDS.code,
    repo: "docs",
    stage: "approval:merge",
    from: "gate",
    waiting: "review and merge PR",
    spec: 54,
    plan: 29,
    pr: 57,
    cost: 4.05,
    agent: 5200,
    attempt: 2,
    created: 2 * DAY,
    moves: [
      [2 * DAY - 30, "pick", "ok", "design"],
      [2 * DAY - 40 * MIN, "design", "wait", "approval:spec"],
      [DAY + 6 * HOUR, "approval:spec", "spec_merged", "plan"],
      [DAY + 5 * HOUR, "plan", "wait", "approval:plan"],
      [DAY + 2 * HOUR, "approval:plan", "plan_merged", "build"],
      [12 * HOUR, "build", "ok", "verify"],
      [11 * HOUR + 30 * MIN, "verify", "red", "build", "2 tests red in docs/links.test.ts"],
      [10 * HOUR, "build", "ok", "verify"],
      [8 * HOUR + 40 * MIN, "verify", "ok", "proof"],
      [8 * HOUR + 30 * MIN, "proof", "ok", "publish", "no proof needed"],
      [8 * HOUR + 25 * MIN, "publish", "ok", "ci"],
      [6 * HOUR, "ci", "ok", "review"],
      [5 * HOUR + 20 * MIN, "review", "ok", "gate"],
      [
        5 * HOUR,
        "gate",
        "wait",
        "approval:merge",
        "The review approved; the change rewrites a whole page, so it needs your merge.",
      ],
    ],
    data: {
      review: {
        summary:
          "The guide now starts with a five-minute path: install, create a project, deploy. Each step has a command and what you should see after it. The old reference material moved to its own page, linked at the end.\n\nAll links resolve, the code samples run in CI, and the screenshots are new. One thing to check: the guide now assumes Node 22; the old one said 18.",
      },
      // AUT-20: the code's risk, shown on its card.
      risk: {
        code: {
          level: "medium",
          said: "low",
          raised: "Raised from low to medium: it could affect many people or systems.",
          blast: { size: "large", who: "Everyone who starts with the docs." },
          door: { kind: "two-way", why: "Reverting the PR brings the old guide back." },
          certainty: { level: "high", why: "Every link and code sample is checked in CI." },
          summary: "A wrong step would stop new users early, but a revert undoes it at once.",
          openPoints: [],
          of: "x",
        },
      },
    },
  });
  addMission(db, now, {
    intent: IDS.building,
    repo: "mobile",
    stage: "build",
    spec: 77,
    plan: 30,
    cost: 14.2,
    agent: 9800,
    created: 7 * HOUR,
    busy: true,
    moves: [
      [7 * HOUR - 30, "pick", "ok", "design"],
      [6 * HOUR + 30 * MIN, "design", "wait", "approval:spec"],
      [5 * HOUR, "approval:spec", "spec_merged", "plan"],
      [4 * HOUR + 30 * MIN, "plan", "wait", "approval:plan"],
      [3 * HOUR, "approval:plan", "plan_merged", "build"],
      [2 * HOUR, "build", "ok", "verify"],
      [
        HOUR + 40 * MIN,
        "verify",
        "red",
        "build",
        "Type error in sync/queue.ts: Property 'retry' does not exist",
      ],
      [12 * MIN, "build", "ok", "verify"],
      [11 * MIN, "verify", "red", "build", "2 tests failing in offline.test.ts"],
    ],
  });
  addMission(db, now, {
    intent: IDS.ci,
    repo: "web",
    stage: "ci",
    pr: 215,
    plan: 32,
    cost: 1.36,
    agent: 1500,
    created: 3 * HOUR,
    moves: [
      [3 * HOUR - 20, "pick", "ok", "design"],
      [2 * HOUR + 50 * MIN, "design", "ok", "plan"],
      [2 * HOUR + 40 * MIN, "plan", "wait", "approval:plan"],
      [HOUR + 30 * MIN, "approval:plan", "plan_merged", "build"],
      [40 * MIN, "build", "ok", "verify"],
      [20 * MIN, "verify", "ok", "proof"],
      [10 * MIN, "proof", "ok", "publish"],
      [4 * MIN, "publish", "ok", "ci"],
    ],
  });
  addMission(db, now, {
    intent: IDS.cooling,
    repo: "docs",
    stage: "build",
    model: "sonnet",
    limit: "sonnet",
    plan: 33,
    cost: 0.88,
    agent: 1100,
    created: 90 * MIN,
    moves: [
      [90 * MIN - 20, "pick", "ok", "design"],
      [80 * MIN, "design", "ok", "plan"],
      [70 * MIN, "plan", "wait", "approval:plan"],
      [40 * MIN, "approval:plan", "plan_merged", "build"],
    ],
  });
  db.setMeta(
    "cooldown:sonnet",
    JSON.stringify({ until: now + 47 * MIN, backoffs: 0, text: "limit", since: now - 20 * MIN }),
  );
  addMission(db, now, {
    intent: IDS.stalled,
    repo: "infra",
    stage: "verify",
    plan: 27,
    cost: 1.72,
    agent: 2100,
    created: 6 * HOUR,
    moves: [
      [6 * HOUR - 20, "pick", "ok", "design"],
      [5 * HOUR + 50 * MIN, "design", "ok", "plan"],
      [5 * HOUR + 40 * MIN, "plan", "wait", "approval:plan"],
      [5 * HOUR + 10 * MIN, "approval:plan", "plan_merged", "build"],
      [5 * HOUR, "build", "ok", "verify"],
      [4 * HOUR + 30 * MIN, "verify", "red", "build", "logrotate test: expected 7 files, found 0"],
      [4 * HOUR, "build", "ok", "verify"],
      [3 * HOUR + 30 * MIN, "verify", "red", "build", "logrotate test: expected 7 files, found 0"],
      [3 * HOUR + 12 * MIN, "build", "ok", "verify"],
    ],
  });
  const doneMoves = (span: number, end: number): MissionSpec["moves"] => [
    [span - 20, "pick", "ok", "design"],
    [span - 15 * MIN, "design", "wait", "approval:spec"],
    [span - 2 * HOUR, "approval:spec", "spec_merged", "plan"],
    [span - 2 * HOUR - 10 * MIN, "plan", "wait", "approval:plan"],
    [span - 3 * HOUR, "approval:plan", "plan_merged", "build"],
    [end + 2 * HOUR, "build", "ok", "verify"],
    [end + HOUR + 40 * MIN, "verify", "ok", "proof"],
    [end + HOUR + 30 * MIN, "proof", "ok", "publish"],
    [end + HOUR + 25 * MIN, "publish", "ok", "ci"],
    [end + HOUR, "ci", "ok", "review"],
    [end + 40 * MIN, "review", "ok", "gate"],
    [end + 30 * MIN, "gate", "wait", "approval:merge"],
    [end, "approval:merge", "code_merged", "done"],
  ];
  addMission(db, now, {
    intent: IDS.done2,
    repo: "api",
    stage: "done",
    spec: 112,
    plan: 25,
    pr: 114,
    cost: 4.8,
    agent: 2900,
    created: 30 * HOUR,
    moves: doneMoves(30 * HOUR, 20 * HOUR),
  });
  addMission(db, now, {
    intent: IDS.done1,
    repo: "web",
    stage: "stopped",
    spec: 201,
    plan: 21,
    pr: 203,
    cost: 1.2,
    agent: 1600,
    created: 3 * DAY + 4 * HOUR,
    moves: [
      [3 * DAY + 4 * HOUR - 30, "pick", "ok", "design"],
      [3 * DAY, "design", "retry_fresh", "stopped", "replaced by attempt 2"],
    ],
  });
  addMission(db, now, {
    intent: IDS.done1,
    repo: "web",
    stage: "done",
    spec: 201,
    plan: 21,
    pr: 206,
    cost: 5.1,
    agent: 2500,
    created: 3 * DAY - 60,
    moves: doneMoves(3 * DAY - 60, 2 * DAY + 3 * HOUR),
    attempt: 2,
  });
  addMission(db, now, {
    intent: IDS.done3,
    repo: "web",
    stage: "done",
    plan: 19,
    pr: 199,
    cost: 2.6,
    agent: 600,
    created: 4 * DAY + 5 * HOUR,
    moves: doneMoves(4 * DAY + 5 * HOUR, 4 * DAY),
  });
  addMission(db, now, {
    intent: IDS.done4,
    repo: "infra",
    stage: "done",
    spec: 40,
    plan: 17,
    pr: 41,
    cost: 3.9,
    agent: 2400,
    created: 6 * DAY + 5 * HOUR,
    moves: doneMoves(6 * DAY + 5 * HOUR, 6 * DAY),
  });
  addMission(db, now, {
    intent: IDS.dropped,
    repo: "mobile",
    stage: "stopped",
    spec: 70,
    cost: 0.95,
    agent: 900,
    created: 3 * DAY + 2 * HOUR,
    moves: [
      [3 * DAY + 2 * HOUR - 30, "pick", "ok", "design"],
      [3 * DAY + HOUR, "design", "wait", "approval:spec"],
      [3 * DAY, "approval:spec", "closed", "stopped", "PR closed"],
    ],
  });

  const runs = (id: string, files: Record<string, string>) => {
    const d = home.runs(id);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  };
  runs(IDS.stalled, {
    "build-1.prompt.md": "# Build\n\nRotate log files daily, keeping seven.\n",
    "build-1.log": "$ claude -p …\nEditing ops/logrotate.conf\nDone.\n",
    "build-1.result.json": '{"status":"done","notes":"Added the logrotate config and a test."}\n',
    "verify-1.log": "$ npm test\nlogrotate test: expected 7 files, found 0\n1 failing\n",
    "verify-2.log": "$ npm test\nlogrotate test: expected 7 files, found 0\n1 failing\n",
  });
  // Stage folders (LOOP-39) for the code intent, with a repair round and a skipped proof.
  const staged = (id: string, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      const [stage, name] = rel.split("/") as [string, string];
      writeFileSync(join(home.runs(id, stage), name), text);
    }
  };
  staged(IDS.code, {
    "design/design-1.prompt": "# Design\n\nRewrite the getting-started guide.\n",
    "design/design-1.json": '{"type":"result","result":"Spec written"}\n',
    "design/settings-design.json": '{"sandbox":{"enabled":true}}\n',
    "plan/plan-1.json": '{"type":"result","result":"Plan written"}\n',
    "build/worker-1.prompt": "# Build\n\nRewrite the guide as a five-minute path.\n",
    "build/worker-1.json": '{"type":"result","result":"Guide rewritten"}\n',
    "build/worker-2.prompt": "# Repair\n\nThe checks failed: 2 tests red in docs/links.test.ts.\n",
    "build/worker-2.json": '{"type":"result","result":"Links fixed"}\n',
    "build/build-setup.log": "$ npm ci\nadded 212 packages\n",
    "build/guard.json": '{"checkout":"work","protected":[],"granted":[],"locked":[]}\n',
    "verify/verify-1.log": `$ npm test\n${Array.from({ length: 240 }, (_, i) => `  ok  link ${i + 1} resolves`).join("\n")}\n2 failing\n  links: /guide/install not found\n  links: /guide/deploy not found\n`,
    "verify/verify-2.log": "$ npm test\n42 passing\n",
    "review/review-1.json": '{"type":"result","result":"The review approved."}\n',
  });
  runs(IDS.plan, {
    "design-1.log": "$ claude -p …\nWrote specs/limits.md\n",
    "plan-1.prompt.md": "# Plan\n\nRate-limit the public API.\n",
    "plan-1.result.json": '{"plan":"…","access":{"domains":[],"paths":[]}}\n',
  });
}

/** Serve the fixture (the screenshot tests and a manual look). */
export async function serveFixture(
  port = 0,
  o: { empty?: boolean } = {},
): Promise<{ fixture: Fixture; server: UiServer }> {
  const fixture = buildFixture(o);
  const here = dirname(fileURLToPath(import.meta.url));
  const server = startUi({
    port,
    sources: fixture.sources,
    actions: fixture.actions,
    distDir: resolve(here, "dist"),
    log: (l) => process.stderr.write(`${l}\n`),
    pollMs: 500,
  });
  await server.ready;
  return { fixture, server };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.PORT ?? 0);
  const { fixture, server } = await serveFixture(port);
  process.stdout.write(`Towercab fixture: ${server.url()}\n`);
  const bye = () => {
    void server.stop().then(() => {
      fixture.cleanup();
      process.exit(0);
    });
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
