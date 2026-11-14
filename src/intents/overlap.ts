// The overlap check (INT-73, LOOP-125): a read-only, tool-less run that compares a draft with the existing
// intents and says which overlap. It runs where the owner asked for it (the page's server or a command),
// outside any mission and takes no build slot. Towercab's code checks what it returns; it writes nothing.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentBudgetUsd, loadAgent } from "../agents.ts";
import { type ClaudeRun, parseRun, prepareRun } from "../claude.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { ProposedPr } from "../github/proposed.ts";
import type { Clock } from "../handlers.ts";
import type { Home } from "../home.ts";
import { fence, render } from "../pipeline/prompts.ts";
import { parseResult, SCHEMAS } from "../pipeline/schemas.ts";
import { isParked } from "../priority.ts";
import { checkoutRoot } from "../service.ts";
import { recordSideRun } from "../side-runs.ts";
import type { Tools } from "../tools.ts";
import type { Draft } from "./create.ts";
import { plainLine, titleProblem } from "./naming.ts";
import type { Intent, IntentStore } from "./types.ts";

export type MatchKind = "open" | "parked" | "done" | "dropped" | "pr";

export interface Match {
  kind: MatchKind;
  /** The intent's ID, or `PR#<n>` for an open intent pull request. */
  ref: string;
  title: string;
  how: string;
  /** The pull request's address, for a `pr` match. */
  url?: string;
}

export interface OverlapResult {
  matches: Match[];
  titleNote?: string;
}

export const MAX_MATCHES = 5;
/** How much of each existing intent the agent reads. */
export const EXCERPT = 600;
/** At most this many checks run at once (LOOP-125). */
export const MAX_CONCURRENT = 2;

export interface OverlapDeps {
  config: Config;
  home: Home;
  tools: Tools;
  clock: Clock;
  store: IntentStore;
  /** The open intent pull requests, as the loop last read them (LOOP-92). */
  proposed: () => ProposedPr[] | Promise<ProposedPr[]>;
  /** Where the cost is written (LOOP-125); without it nothing is recorded. */
  db?: Db | null;
  /** LOOP-108: a draining service refuses a check. */
  draining?: () => boolean;
  /** USR-5: only the repos the person has a role in are read; default all. */
  visible?: (repo: string) => boolean;
  limiter?: Limiter;
  log?: (line: string) => void;
  towercabExe?: string;
  userHome?: string;
}

/** A semaphore: a third check waits for one of the first two. */
export class Limiter {
  private running = 0;
  private queue: (() => void)[] = [];
  readonly max: number;
  constructor(max = MAX_CONCURRENT) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

const shared = new Limiter();

interface Item {
  ref: string;
  kind: MatchKind;
  repo: string;
  title: string;
  excerpt: string;
  url?: string;
}

const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, EXCERPT);

function itemOf(i: Intent, cutoff: number): Item {
  const kind: MatchKind = i.done
    ? i.stage === "dropped"
      ? "dropped"
      : "done"
    : isParked(i, cutoff)
      ? "parked"
      : "open";
  return { ref: i.id, kind, repo: i.repo, title: i.title, excerpt: clip(i.sections.get("Problem") ?? "") };
}

/** What the agent is given: readable intents of main and the open intent PRs; unreadable ones are left out. */
export async function existingItems(d: OverlapDeps): Promise<Item[]> {
  const see = d.visible ?? (() => true);
  const listing = await d.store.list();
  const cutoff = d.config.intents.cutoff;
  const items = [...listing.open, ...listing.done].filter((i) => see(i.repo)).map((i) => itemOf(i, cutoff));
  for (const p of await d.proposed()) {
    if (!see(p.intent?.repo ?? "")) continue;
    items.push({
      ref: `PR#${p.number}`,
      kind: "pr",
      repo: p.intent?.repo ?? "",
      title: p.intent?.title ?? p.title,
      excerpt: "",
      url: p.url,
    });
  }
  return items;
}

const lineOf = (i: Item) => `[${i.ref}] ${i.kind} ${i.repo}: ${i.title}${i.excerpt ? `\n${i.excerpt}` : ""}`;

function draftText(d: Draft): string {
  return [
    `repo: ${d.repo}`,
    `title: ${d.title}`,
    ...(
      [
        ["Problem", d.problem],
        ["Proposed outcome", d.outcome],
        ["Affected users and systems", d.affected],
        ["Constraints", d.constraints],
        ["Open questions", d.questions],
      ] as const
    ).flatMap(([n, t]) => (t?.trim() ? [`${n}: ${t.trim()}`] : [])),
  ].join("\n");
}

/** A note that quotes a replacement title is cut to the plain fact. */
function noteOf(raw: string, title: string): string | undefined {
  const agent = plainLine(raw, 160);
  const problem = titleProblem(title);
  if (!agent) return problem ? `The title doesn't follow the naming rule: ${problem}.` : undefined;
  if (/["“”'‘’][^"“”'‘’]{20,}["“”'‘’]/.test(agent)) return "The title doesn't follow the naming rule.";
  return agent;
}

async function run(d: OverlapDeps, draft: Draft, items: Item[]): Promise<{ raw: unknown; cost: number }> {
  const agent = loadAgent("overlap");
  const runsDir = d.home.runs("overlap");
  const cwd = join(runsDir, "empty");
  mkdirSync(cwd, { recursive: true });
  const n = readdirSync(runsDir).filter((f) => /^score-\d+\.prompt$/.test(f)).length + 1;
  const spec: ClaudeRun = {
    kind: "score",
    model: d.config.agent.model,
    cwd,
    runsDir,
    n,
    prompt: render("overlap", {
      draft: fence(draftText(draft), "draft"),
      existing: fence(items.map(lineOf).join("\n\n") || "(nothing yet)", "existing"),
    }),
    agent: "overlap",
    schema: SCHEMAS[agent.schema!],
    session: { mode: "none", id: "" },
    budgetUsd: agentBudgetUsd(agent, d.config),
    claudeMd: "",
    grants: { domains: [], paths: [], open: false },
    cacheEnv: {},
    config: d.config,
  };
  const home = d.userHome ?? homedir();
  const child = {
    ...prepareRun(spec, { towercabExe: d.towercabExe ?? join(checkoutRoot(), "bin", "towercab"), home }),
    slot: false,
  };
  const handle = d.tools.spawn(child);
  let timer: NodeJS.Timeout | undefined;
  const end = await Promise.race([
    handle.done,
    new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), agent.timeoutMin * 60_000);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  if (end === "timeout") {
    handle.kill("SIGKILL");
    throw new Error("it timed out");
  }
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  const r = parseRun(read(child.stdout), read(child.stderr), end.code, {
    model: d.config.agent.model,
    now: new Date(d.clock.now() * 1000),
    home,
  });
  const cost = "result" in r && r.result ? r.result.costUsd : 0;
  if (r.kind !== "ok")
    throw Object.assign(new Error(r.kind === "env" ? `${r.fault}: ${r.text}` : r.kind), { cost });
  return { raw: r.result.structuredOutput, cost };
}

/**
 * INT-73: the intents and open proposals that overlap `draft`, each with a line on how. A read or a run
 * that fails is an error (`The overlap check failed: <reason>`), never an empty list.
 */
export async function checkOverlap(d: OverlapDeps, draft: Draft): Promise<OverlapResult> {
  if (d.draining?.()) throw new Error("Towercab is restarting; try again in a minute");
  return (d.limiter ?? shared).run(async () => {
    let cost = 0;
    try {
      const items = await existingItems(d);
      const out = await run(d, draft, items);
      cost = out.cost;
      const parsed = parseResult("overlap", out.raw);
      if (!parsed.ok) throw new Error(`its answer was not usable: ${parsed.why}`);
      const byRef = new Map(items.map((i) => [i.ref, i]));
      const seen = new Set<string>();
      const matches: Match[] = [];
      for (const m of parsed.value.matches) {
        const item = byRef.get(m.ref);
        const how = plainLine(m.how, 160);
        if (!item || seen.has(item.ref) || !how) continue;
        seen.add(item.ref);
        matches.push({
          kind: item.kind,
          ref: item.ref,
          title: item.title,
          how,
          ...(item.url ? { url: item.url } : {}),
        });
        if (matches.length === MAX_MATCHES) break;
      }
      const titleNote = noteOf(parsed.value.title_note, draft.title);
      return { matches, ...(titleNote ? { titleNote } : {}) };
    } catch (e) {
      cost = cost || (e as { cost?: number }).cost || 0;
      throw new Error(`The overlap check failed: ${(e as Error).message}`);
    } finally {
      if (d.db && cost > 0) recordSideRun(d.db, { at: d.clock.now(), kind: "overlap", cost });
    }
  });
}
