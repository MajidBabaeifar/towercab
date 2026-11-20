// An observer over fakes: a fake `claude` child, a fake `gh`, a local bare repo for the intents repo, a
// clock the test moves. Hermetic: temp home, in-memory database, never the network.

import { readFileSync, writeFileSync } from "node:fs";
import type { Config } from "../../src/config.ts";
import type { ProposedPr } from "../../src/github/proposed.ts";
import type { IntentStore, Listing } from "../../src/intents/types.ts";
import { Observer } from "../../src/observer/observer.ts";
import type { ObserverFinding } from "../../src/pipeline/schemas.ts";
import type { ChildExit, ChildSpec } from "../../src/tools.ts";
import { fakeGitHub } from "../github/fakes.ts";
import { FakeTools, failResult, okResult } from "../helpers/tools.ts";
import { bareRepo, TestClock, testConfig, testDb, testHome } from "../helpers/world.ts";
import { listing } from "../intents/fixtures.ts";

/** A local time as unix seconds. */
export const local = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime() / 1000;

/** Monday 2026-11-09, shortly after 06:00. */
export const MONDAY = local(2026, 11, 9, 6, 1);

export function finding(over: Partial<ObserverFinding> = {}): ObserverFinding {
  return {
    title: "Towercab stops retrying a check that fails the same way every time",
    repo: "web",
    problem: "The same check failed in 6 of 9 runs.",
    outcome: "Fewer repairs per intent.",
    gain: "About 2 fewer repairs per intent.",
    u: 3,
    i: 4,
    a: 3,
    evidence: [
      { id: "i-1", shows: "failed twice" },
      { id: "i-2", shows: "failed three times" },
    ],
    overlaps: [],
    ...over,
  };
}

/** What `claude -p --output-format json` prints for an observer run. */
export function claudeResult(findings: ObserverFinding[], cost = 0.2, subtype = "success"): string {
  return `${JSON.stringify({
    type: "result",
    subtype,
    is_error: false,
    result: "",
    session_id: "s",
    total_cost_usd: cost,
    duration_ms: 5,
    permission_denials: [],
    modelUsage: {},
    structured_output: { findings },
  })}\n`;
}

export const answers =
  (findings: ObserverFinding[], cost = 0.2) =>
  (spec: ChildSpec): ChildExit => {
    writeFileSync(spec.stdout, claudeResult(findings, cost));
    writeFileSync(spec.stderr, "");
    return { code: 0, signal: null };
  };

/** An open proposal on the intents repo, as the loop reads it (LOOP-92). */
export function proposedPr(number: number, title: string, source: string | null = "observer"): ProposedPr {
  return {
    number,
    url: `https://github.com/owner/intents/pull/${number}`,
    title: `docs(intents): add ${title}`,
    draft: false,
    proposer: "Towercab",
    createdAt: MONDAY - 3600,
    head: "abc",
    path: `intents/260101-0900-${number}/intent.md`,
    intent: { title, repo: "web", u: 3, i: 3, a: 3, source },
    textUrl: null,
    acceptable: true,
    reason: null,
  };
}

export class ObsRig {
  config: Config;
  db = testDb();
  home = testHome();
  clock = new TestClock(MONDAY);
  tools = new FakeTools();
  intents = bareRepo({ "README.md": "intents\n" });
  /** `gh pr create` calls, `gh pr comment` calls with their text. */
  created: string[][] = [];
  comments: { args: string[]; text: string }[] = [];
  /** What `gh pr list --head` answers. */
  onBranch = "[]";
  listing: Listing | null = listing([]);
  proposed: ProposedPr[] = [];
  steering: string | null = null;
  faults: string[] = [];
  fine: string[] = [];
  logs: string[] = [];

  constructor(observer: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    this.config = testConfig({
      intents: { remote: this.intents },
      repos: { web: { github: "owner/web" }, ci: { github: "owner/ci" } },
      observer,
      ...extra,
    });
    this.tools.on("gh", (args, opts) => {
      if (args[0] === "pr" && args[1] === "list") {
        return okResult(args.includes("--head") ? this.onBranch : "[]");
      }
      if (args[0] === "pr" && args[1] === "create") {
        this.created.push(args);
        return okResult(`https://github.com/owner/intents/pull/${6 + this.created.length}\n`);
      }
      if (args[0] === "pr" && args[1] === "comment") {
        this.comments.push({ args, text: opts.input ?? "" });
        return okResult("");
      }
      return failResult(`gh ${args.join(" ")}: not faked`);
    });
    // Two intents that ran, so there is something to cite.
    this.mission("i-1", "web");
    this.mission("i-2", "web");
  }

  mission(intent: string, repo: string, set: Record<string, string | number> = {}): void {
    const cols = {
      intent,
      repo,
      attempt: 1,
      stage: "build",
      model: "opus",
      session: "s",
      checkout: "w",
      branch: "b",
      created: this.clock.now() - 3600,
      updated: this.clock.now() - 60,
      ...set,
    };
    const names = Object.keys(cols);
    this.db.run(
      `INSERT INTO missions (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      ...Object.values(cols),
    );
  }

  store(): IntentStore {
    return { github: () => "owner/intents" } as unknown as IntentStore;
  }

  observer(): Observer {
    return new Observer({
      config: this.config,
      home: this.home,
      db: this.db,
      tools: this.tools,
      clock: this.clock,
      github: fakeGitHub(this.tools),
      store: this.store(),
      log: (l) => this.logs.push(l),
      listing: () => this.listing,
      proposed: () => this.proposed,
      steering: () => this.steering,
      health: {
        fail: (k) => {
          this.faults.push(k);
        },
        ok: (k) => {
          this.fine.push(k);
        },
      },
      userHome: "/home/owner",
      towercabExe: "/bin/towercab",
    });
  }

  /** Queue a child answering with these findings. */
  child(findings: ObserverFinding[], cost = 0.2): this {
    this.tools.child("claude", answers(findings, cost));
    return this;
  }

  /** Passes until the run has ended and been handled. */
  async run(o: Observer, max = 12): Promise<void> {
    for (let n = 0; n < max; n++) {
      await o.pass();
      await new Promise((r) => setImmediate(r));
      if (!o.busy()) {
        await o.pass();
        if (!o.busy()) return;
      }
    }
  }

  runs() {
    return this.db.all<{
      id: number;
      trigger: string;
      outcome: string;
      cost: number;
      proposals: number;
      comments: number;
      findings: number;
      dropped: string;
      detail: string;
    }>("SELECT * FROM observer_runs ORDER BY id");
  }

  outbox(): { key: string; text: string }[] {
    return this.db.all<{ key: string; text: string }>("SELECT key, text FROM outbox ORDER BY created, rowid");
  }

  prompt(): string {
    const spec = this.tools.spawned[0];
    return spec?.stdin ? readFileSync(spec.stdin, "utf8") : "";
  }
}
