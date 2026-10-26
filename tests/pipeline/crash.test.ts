// Durable steps (LOOP-6): Towercab dies right after a durable write (a transaction, a write to the
// intents repo, a push, a PR created, merged or edited) at every point of an a5 intent's flow, and a
// fresh loop on the same database and home still takes the intent to done, making each write once.
//
// One run covers every point: each kind of write at each stage and step crashes the first time it
// happens (later ones are the recovery redoing it), then a new loop starts as after a restart.

import { expect, test } from "vitest";
import type { SqlValue } from "../../src/db.ts";
import type { IntentStore } from "../../src/intents/types.ts";
import type { RunOpts } from "../../src/tools.ts";
import { build, happy, ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { type ClaudeReply, Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

class Crash extends Error {}

/**
 * Run `p`'s flow to done, dying after the first write of each kind at each stage and step and
 * restarting; `between` acts for the owner between passes. Returns where it died.
 */
async function crashing(p: Pipe, between: () => void = () => {}): Promise<string[]> {
  const seen = new Set<string>();
  const points: string[] = [];
  let dead = false;

  /** A durable write just completed: the first time this kind of write happens here, die. */
  const wrote = (kind: string) => {
    const m = p.mission();
    const sig = `${kind} @ ${m?.stage ?? "-"}/${m?.step ?? "-"}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    points.push(sig);
    dead = true;
    p.tools.dead = () => new Crash(`dead after ${sig}`);
    throw new Crash(`dead after ${sig}`);
  };
  const alive = () => {
    if (dead) throw new Crash("dead");
  };

  // The database: a transaction's commit, or a single write outside one.
  const db = p.db;
  const tx = db.tx.bind(db);
  const run = db.run.bind(db);
  let depth = 0;
  let inTx = new Set<string>();
  const what = (q: string) => {
    const m = /^\s*(INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM)\s+(\w+)/i.exec(q);
    return m ? `${m[1]!.split(" ")[0]!.toLowerCase()} ${m[2]}` : null;
  };
  db.tx = (<T>(fn: () => T): T => {
    alive();
    if (depth === 0) inTx = new Set();
    depth++;
    let out: T;
    try {
      out = tx(fn);
    } finally {
      depth--;
    }
    if (depth === 0 && inTx.size) wrote(`tx ${[...inTx].sort().join("+")}`);
    return out;
  }) as typeof db.tx;
  db.run = (q: string, ...params: SqlValue[]) => {
    const w = what(q);
    if (w) alive();
    const r = run(q, ...params);
    // The pass's own bookkeeping (last pass, health) is no step's write.
    const bookkeeping = w === "insert meta" && (params[0] === "last_pass" || params[0] === "health");
    if (w && depth > 0) inTx.add(w);
    else if (w && !bookkeeping) wrote(`run ${w}`);
    return r;
  };

  // GitHub and the repos: a PR created, merged, commented or edited; a push.
  const mutation = (cmd: string, args: string[]) => {
    if (cmd === "git" && args.includes("push")) return "git push";
    if (cmd !== "gh") return null;
    const a = args[0] === "--as-owner" ? args.slice(1) : args;
    if (a[0] === "pr" && ["create", "merge", "comment", "close", "ready"].includes(a[1]!))
      return `gh pr ${a[1]}`;
    if (a[0] === "run" && a[1] === "rerun") return "gh run rerun";
    if (a[0] === "api" && (a.includes("PATCH") || a.includes("PUT"))) return `gh api ${a[2]}`;
    return null;
  };
  const toolsRun = p.tools.run.bind(p.tools);
  p.tools.run = async (cmd: string, args: string[], opts: RunOpts = {}) => {
    const r = await toolsRun(cmd, args, opts);
    const kind = mutation(cmd, args);
    if (kind && r.code === 0) wrote(kind);
    return r;
  };

  // The intents repo, through the store.
  const wrapStore = (s: IntentStore): IntentStore => ({
    list: async () => {
      alive();
      return s.list();
    },
    get: async (id) => {
      alive();
      return s.get(id);
    },
    readFile: async (path) => {
      alive();
      return s.readFile(path);
    },
    hasMark: async (mark) => {
      alive();
      return s.hasMark(mark);
    },
    github: () => s.github(),
    url: (i) => s.url(i),
    add: async (n, now) => {
      alive();
      const out = await s.add(n, now);
      wrote("store add");
      return out;
    },
    update: async (id, w, fn, mark) => {
      alive();
      const out = await s.update(id, w, fn, mark);
      wrote(`store ${w}`);
      return out;
    },
  });

  /** A restart after a crash: the dead loop is dropped, a new one opens on the same database. */
  const restart = async () => {
    for (;;) {
      dead = false;
      p.tools.dead = null;
      // The three-crash rule (`loop: three crashes wait for the owner`) would stop this run early.
      run("UPDATE missions SET unclean = 0");
      try {
        await p.reopen();
        return;
      } catch (e) {
        if (!(e instanceof Crash)) throw e;
      }
    }
  };

  for (;;) {
    try {
      await p.start({}, { wrapStore });
      break;
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
      dead = false;
      p.tools.dead = null;
    }
  }
  let passes = 0;
  const finished = () => {
    const m = p.mission();
    return m?.stage === "done" && m.step === "";
  };
  while (!finished() && passes < 600) {
    passes++;
    between();
    try {
      await p.loop.pass();
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
    }
    if (dead) await restart();
    p.clock.advance(61);
  }

  expect(finished(), `${p.moves()}\n\ncrashed after:\n${points.join("\n")}`).toBe(true);
  return points;
}

/** The moves' intent writes each landed once, and the intent is done after one attempt. */
function writtenOnce(p: Pipe): void {
  expect(p.db.all("SELECT id FROM missions")).toHaveLength(1);
  expect(p.mission()!.attempt).toBe(1);
  // Each PR opened once and merged once; the spec landed first.
  expect(p.prs.map((x) => [x.repo, x.title, x.state])).toEqual([
    ["owner/web", "docs(specs): Show a greeting", "MERGED"],
    ["owner/intents", "docs(plan): Show a greeting", "MERGED"],
    ["owner/web", "feat: show a greeting", "MERGED"],
  ]);
  const log = git(p.bares.web!, "log", "--format=%s", "main");
  expect(log.split("\n").filter((l) => l.startsWith("docs(specs)"))).toHaveLength(1);
  expect(log.split("\n").filter((l) => l.startsWith("feat: show a greeting"))).toHaveLength(1);
  // Each review round commented once.
  expect(p.prs[2]!.comments.filter((c) => c.body.startsWith("<!-- towercab:review:"))).toHaveLength(1);
  // Each move's intent write landed once.
  const marks = git(p.bares.intents!, "log", "--format=%B", "main")
    .split("\n")
    .filter((l) => l.startsWith("Towercab-Entry: "));
  expect(new Set(marks).size).toBe(marks.length);
  const done = git(p.bares.intents!, "show", `main:done/${ID}-${SLUG}/intent.md`);
  expect(done).toMatch(/stage: done/);
  expect(done).toMatch(/attempts: 1/);
  expect(git(p.bares.intents!, "show", `main:done/${ID}-${SLUG}/plan.md`)).toContain(
    "# Plan: Show a greeting",
  );
}

test("loop: a crash at every durable write still ends done once", async () => {
  // a5: Towercab merges all three PRs itself.
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  const points = await crashing(p);
  // Every kind of write crashed at least once, at many points of the flow.
  const kinds = new Set(points.map((s) => s.split(" @ ")[0]!));
  for (const k of ["tx insert", "run update", "git push", "gh pr create", "gh pr merge", "store", "gh api"])
    expect(
      [...kinds].some((x) => x.startsWith(k)),
      k,
    ).toBe(true);
  expect(points.length).toBeGreaterThan(100);
  writtenOnce(p);

  // a2: the owner merges each PR, and the first build's checks fail once.
  const q = new Pipe(TARGET, intents(intent({ a: 2 })));
  happy(q);
  q.respond.worker = (): ClaudeReply => {
    const repairing = Boolean(JSON.parse(q.mission()!.data).repair);
    return {
      structured: build(),
      edits: repairing
        ? { "greeting.txt": "hello\n" }
        : { "greeting.txt": "bye\n", "tests/greeting.sh": "grep -q hello greeting.txt\n" },
    };
  };
  const owner = () => {
    const m = q.mission();
    if (!m?.stage.startsWith("approval:") || m.step !== "") return;
    const [repo, n] =
      m.stage === "approval:spec"
        ? ["web", m.spec_pr]
        : m.stage === "approval:plan"
          ? ["intents", m.plan_pr]
          : ["web", m.pr];
    const pr = q.prNo(repo!, n!);
    if (pr.state === "OPEN") q.mergePr(pr);
  };
  const more = await crashing(q, owner);
  expect(more.length).toBeGreaterThan(100);
  writtenOnce(q);
  const m = q.mission()!;
  expect(q.stages(m.id).filter((s) => s.startsWith("approval:"))).toEqual([
    "approval:spec",
    "approval:plan",
    "approval:merge",
  ]);
  expect(q.db.all("SELECT from_stage FROM transitions WHERE event = 'red'")).toEqual([
    { from_stage: "verify" },
  ]);
  expect(q.show("web", "main", "greeting.txt")).toBe("hello\n");
}, 120_000);
