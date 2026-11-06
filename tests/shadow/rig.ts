// A shadow over fakes: a fake Bot API, a fake `claude` child, fake page actions and a fake intent store.
// Hermetic: temp home, in-memory database, a clock the test moves.

import { readFileSync, writeFileSync } from "node:fs";
import { SHADOW_FREE } from "../../src/config.ts";
import type { Intent, IntentEdit, IntentStore } from "../../src/intents/types.ts";
import type { ShadowResult } from "../../src/pipeline/schemas.ts";
import { Executor } from "../../src/shadow/actions.ts";
import { Shadow } from "../../src/shadow/shadow.ts";
import type { TelegramUpdate } from "../../src/telegram.ts";
import type { ChildExit, ChildSpec } from "../../src/tools.ts";
import type { UiActions } from "../../src/ui/actions.ts";
import { FakeTools } from "../helpers/tools.ts";
import { TestClock, testConfig, testDb, testHome } from "../helpers/world.ts";

export const CHAT = "42";

/** What `claude -p --output-format json` prints for a shadow turn. */
export function claudeResult(out: Partial<ShadowResult>, cost = 0.1): string {
  return `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    session_id: "claude-session",
    total_cost_usd: cost,
    duration_ms: 5,
    permission_denials: [],
    modelUsage: {},
    structured_output: { reply: "", reads: [], actions: [], ...out },
  })}\n`;
}

/** A child that answers with `out` at once. */
export const answers =
  (out: Partial<ShadowResult>, cost = 0.1) =>
  (spec: ChildSpec): ChildExit => {
    writeFileSync(spec.stdout, claudeResult(out, cost));
    writeFileSync(spec.stderr, "");
    return { code: 0, signal: null };
  };

export type Calls = string[];

export class FakeStore {
  intents = new Map<
    string,
    { id: string; title: string; source: string | null; u: number | null; i: number | null }
  >();
  added: Record<string, unknown>[] = [];
  updated: { id: string; what: string; mark?: string; fields: Record<string, unknown> }[] = [];

  constructor() {
    this.intents.set("i-1", { id: "i-1", title: "First", source: "me", u: 3, i: 4 });
    this.intents.set("d-1", { id: "d-1", title: "Draft", source: "shadow", u: 3, i: 3 });
  }

  async get(id: string): Promise<Intent> {
    const i = this.intents.get(id);
    if (!i) throw new Error(`no open intent matches ${id}`);
    return i as unknown as Intent;
  }

  async add(n: Record<string, unknown>): Promise<Intent> {
    this.added.push(n);
    const made = { id: "n-1", title: String(n.title), source: String(n.source), u: 3, i: 3 };
    this.intents.set(made.id, made);
    return made as unknown as Intent;
  }

  async update(id: string, what: string, fn: (e: IntentEdit) => void, mark?: string): Promise<Intent> {
    const fields: Record<string, unknown> = {};
    fn({
      setField: (k: string, v: unknown) => {
        fields[k] = v;
      },
    } as unknown as IntentEdit);
    this.updated.push({ id, what, mark, fields });
    return this.get(id);
  }

  github = () => null;
}

export class Rig {
  config;
  db = testDb();
  home = testHome();
  clock = new TestClock();
  tools = new FakeTools();
  store = new FakeStore();
  updates: TelegramUpdate[] = [];
  polls = 0;
  failPolls = false;
  /** The Bot API offers every update again, as it does until the offset moves. */
  offerAll = false;
  state = "STATE-ONE";
  readText = "read result";
  readsAsked: string[] = [];
  calls: Calls = [];
  /** Run at each page action, to look at the database as it was then. */
  onAction: (what: string) => void = () => {};
  private nextUpdate = 1;

  constructor(shadow: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    this.config = testConfig({
      telegram: { bot_token: "123:tok", chat_id: CHAT },
      shadow: { enabled: true, ...shadow },
      ...extra,
    });
  }

  ui(): UiActions {
    const log = (name: string) => async (intent: string, text?: string) => {
      this.onAction(name);
      this.calls.push(`${name} ${intent}${text ? ` ${text}` : ""}`);
      return `${name} done`;
    };
    return {
      reply: log("reply"),
      start: log("start"),
      merge: log("merge"),
      drop: log("drop"),
    } as unknown as UiActions;
  }

  exec(store: IntentStore = this.store as unknown as IntentStore): Executor {
    return new Executor({
      db: this.db,
      clock: this.clock,
      config: this.config,
      store,
      ui: this.ui(),
      log: () => {},
    });
  }

  /** A shadow instance (a restart is a new one over the same database). */
  shadow(exec: Executor = this.exec()): Shadow {
    return new Shadow({
      config: this.config,
      home: this.home,
      db: this.db,
      tools: this.tools,
      clock: this.clock,
      log: () => {},
      telegram: {
        updates: async (offset) => {
          this.polls++;
          if (this.failPolls) throw new Error("telegram getUpdates: HTTP 502");
          return this.updates.filter((u) => this.offerAll || u.id >= offset);
        },
      },
      snapshot: async () => this.state,
      read: async (kind, ref) => {
        this.readsAsked.push(`${kind} ${ref}`);
        return this.readText;
      },
      exec,
      userHome: "/home/owner",
      towercabExe: "/bin/towercab",
    });
  }

  /** The owner writes in the chat. */
  say(text: string, chat = CHAT): number {
    const id = this.nextUpdate++;
    this.updates.push({ id, chat, text });
    return id;
  }

  /** Queue a child for the next run of `claude`. */
  child(out: Partial<ShadowResult>, cost = 0.1): this {
    this.tools.child("claude", answers(out, cost));
    return this;
  }

  /** Passes until the turn has ended (child finished and reaped). */
  async run(sh: Shadow, max = 12): Promise<void> {
    for (let i = 0; i < max; i++) {
      await sh.pass();
      await new Promise((r) => setImmediate(r));
      if (!sh.busy()) {
        await sh.pass();
        if (!sh.busy()) return;
      }
    }
  }

  outbox(): string[] {
    return this.db
      .all<{ text: string }>("SELECT text FROM outbox ORDER BY created, rowid")
      .map((r) => r.text);
  }

  /** A mission waiting as `waiting` says (a stage follows from the wait). */
  mission(intent: string, stage: string, waiting: string, pr = 7): void {
    this.db.run(
      `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, pr, created, updated)
       VALUES (?, 'web', 1, ?, ?, 'opus', 's', 'w', 'b', ?, 0, 0)`,
      intent,
      stage,
      waiting,
      pr,
    );
    // A code PR at its merge wait is ready: checks green, an approving review (SHD-9).
    if (waiting === "review and merge PR") {
      this.db.run(
        "UPDATE missions SET data = ? WHERE intent = ?",
        JSON.stringify({
          ci: { result: "green" },
          review: {
            approved: true,
            door: "two-way",
            redLines: false,
            summary: "",
            details: "",
            patchId: "p",
          },
        }),
        intent,
      );
    }
  }

  prompts(): string[] {
    return this.tools.spawned.map((s) => (s.stdin ? readFileSafe(s.stdin) : ""));
  }
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export const ALL_FREE = [...SHADOW_FREE];
