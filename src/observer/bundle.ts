// The observer's evidence (OBV-3): the last 14 days of how Towercab ran, built by code from the database
// and the run folders. The agent sees nothing else. Every item carries an id it can cite, text is cut to a
// size limit with the cut named, and secrets are removed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { ProposedPr } from "../github/proposed.ts";
import type { Home } from "../home.ts";
import type { Listing } from "../intents/types.ts";
import { storedReadiness } from "../readiness.ts";
import { redact } from "../ui/state.ts";

export const WINDOW_S = 14 * 86_400;
const DONE_WINDOW_S = 30 * 86_400;

export interface Bundle {
  text: string;
  /** Everything the agent may cite: intent ids and `owner/name#number`. */
  ids: Set<string>;
  /** What the size limit cut, in words. */
  cut: string[];
}

export interface BundleInput {
  db: Db;
  config: Config;
  home: Home;
  now: number;
  listing: Listing | null;
  proposed: ProposedPr[];
  /** `owner/name` of the intents repo, or null. */
  intentsRepo: string | null;
}

interface MissionRow {
  id: number;
  intent: string;
  repo: string;
  attempt: number;
  stage: string;
  waiting: string | null;
  why: string | null;
  repairs: number;
  ci_repairs: number;
  retries: number;
  cost_usd: number;
  agent_secs: number;
  spec_pr: number | null;
  plan_pr: number | null;
  pr: number | null;
  data: string;
  created: number;
  updated: number;
  finished: number | null;
}

interface Move {
  at: number;
  to_stage: string;
  event: string;
  why: string | null;
}

interface Command {
  name: string;
  arg: string;
  text: string;
  source: string;
  created: number;
  result: string | null;
}

const iso = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};
function span(s: number): string {
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

/** The newest run file of an intent that ends in `.err` or `.json`, and its last 400 characters. */
function logTail(home: Home, intent: string): string {
  const root = join(home.root, "runs", intent);
  const best = { path: "", at: 0 };
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      try {
        const st = statSync(p);
        if (st.isDirectory() && depth < 2) walk(p, depth + 1);
        else if (st.isFile() && /\.(err|json)$/.test(n) && st.mtimeMs > best.at)
          Object.assign(best, { path: p, at: st.mtimeMs });
      } catch {
        // gone between listing and reading
      }
    }
  };
  walk(root, 0);
  if (!best.path) return "";
  try {
    return clip(readFileSync(best.path, "utf8").slice(-1_200), 400);
  } catch {
    return "";
  }
}

function dataBits(data: string): string {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const k of ["review", "ci", "alerts", "risk"]) {
    if (d[k] === undefined || d[k] === null) continue;
    parts.push(`${k}=${clip(JSON.stringify(d[k]), 300)}`);
  }
  return parts.join(" ");
}

/** Seconds spent in each stage, from the transitions of one mission. */
function stageSecs(
  ts: { at: number; to_stage: string }[],
  end: number,
): [string, number][] {
  const by = new Map<string, number>();
  for (let i = 0; i < ts.length; i++) {
    const next = ts[i + 1]?.at ?? end;
    by.set(ts[i]!.to_stage, (by.get(ts[i]!.to_stage) ?? 0) + Math.max(0, next - ts[i]!.at));
  }
  return [...by.entries()].sort((a, b) => b[1] - a[1]);
}

export function buildBundle(i: BundleInput): Bundle {
  const { db, config, home, now } = i;
  const ids = new Set<string>();
  const cut: string[] = [];
  const limit = config.observer.bundleKb * 1024;
  let size = 0;
  const out: string[] = [];
  const add = (section: string, lines: string[]) => {
    if (!lines.length) return;
    const head = `\n## ${section}`;
    out.push(head);
    size += head.length;
    let dropped = 0;
    for (const l of lines) {
      if (size + l.length + 1 > limit) dropped++;
      else {
        out.push(l);
        size += l.length + 1;
      }
    }
    if (dropped) cut.push(`${section}: ${dropped} more not shown`);
  };

  const since = now - WINDOW_S;
  const prId = (repo: string, n: number | null): string | null => {
    if (!n) return null;
    const gh = config.repos.get(repo)?.github;
    return gh ? `${gh}#${n}` : null;
  };

  // Repos: where a fix can belong (OBV-4).
  add(
    "Repos",
    [...config.repos.values()].map((r) => {
      const kind = storedReadiness(db, r.name)?.readiness.kind;
      return `- ${r.name} (${r.github})${kind ? `: ${kind}` : ""}`;
    }),
  );

  const missions = db.all<MissionRow>(
    "SELECT * FROM missions WHERE updated >= ? ORDER BY updated DESC LIMIT 300",
    since,
  );
  const transitions = new Map<number, Move[]>();
  for (const t of db.all<Move & { mission: number }>(
    "SELECT mission, at, to_stage, event, why FROM transitions WHERE at >= ? ORDER BY at",
    since,
  )) {
    const l = transitions.get(t.mission) ?? [];
    l.push(t);
    transitions.set(t.mission, l);
  }

  const tails = new Set(
    [...missions]
      .filter((m) => m.ci_repairs >= 2 || m.repairs >= 2 || m.cost_usd >= 5 || m.retries >= 2)
      .sort((a, b) => b.cost_usd - a.cost_usd)
      .slice(0, 15)
      .map((m) => m.id),
  );

  const mlines: string[] = [];
  for (const m of missions) {
    ids.add(m.intent);
    const prs = [
      ["code", prId(m.repo, m.pr)],
      ["spec", prId(m.repo, m.spec_pr)],
      ["plan", i.intentsRepo && m.plan_pr ? `${i.intentsRepo}#${m.plan_pr}` : null],
    ].filter((x): x is [string, string] => x[1] !== null);
    for (const [, id] of prs) ids.add(id);
    const ts = transitions.get(m.id) ?? [];
    const stages = stageSecs(ts, m.finished ?? Math.min(now, m.updated))
      .slice(0, 4)
      .map(([s, secs]) => `${s} ${span(secs)}`)
      .join(", ");
    const line = [
      `- ${m.intent} (${m.repo}, attempt ${m.attempt}) now ${m.stage}${m.waiting ? `, waiting: ${clip(m.waiting, 80)}` : ""}${m.why ? ` — ${clip(m.why, 160)}` : ""}`,
      `  repairs ${m.repairs}, red checks fixed ${m.ci_repairs}, retries ${m.retries}, cost $${m.cost_usd.toFixed(2)}, agent time ${span(m.agent_secs)}, from ${iso(m.created)} to ${m.finished ? iso(m.finished) : "still open"}`,
      stages ? `  time by stage: ${stages}` : "",
      prs.length ? `  PRs: ${prs.map(([k, id]) => `${k} ${id}`).join(", ")}` : "",
      dataBits(m.data) ? `  ${dataBits(m.data)}` : "",
      tails.has(m.id) && logTail(home, m.intent) ? `  log end: ${logTail(home, m.intent)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    mlines.push(line);
  }
  add("Intents that ran (newest first)", mlines);

  // Moves with their reasons: why things waited, failed or went back.
  const tlines: string[] = [];
  for (const m of missions) {
    for (const t of (transitions.get(m.id) ?? []).slice(-12)) {
      if (!t.why) continue;
      tlines.push(`- ${m.intent} ${iso(t.at)} ${t.event} → ${t.to_stage}: ${clip(t.why, 200)}`);
    }
  }
  add("Why things moved", tlines);

  // The owner's replies and decisions.
  add(
    "The owner's replies and decisions",
    db
      .all<Command>(
        "SELECT name, arg, text, source, created, result FROM commands WHERE created >= ? ORDER BY created DESC LIMIT 200",
        since,
      )
      .map(
        (c) =>
          `- ${iso(c.created)} ${c.name} ${c.arg} (${c.source})${c.text ? `: ${clip(c.text, 200)}` : ""}${c.result ? ` → ${clip(c.result, 100)}` : ""}`,
      ),
  );

  // Intents and proposals already there (OBV-6).
  const l = i.listing;
  if (l) {
    for (const x of l.open) ids.add(x.id);
    add(
      "Open intents",
      l.open.map(
        (x) => `- ${x.id} (${x.repo}) ${clip(x.title, 120)} [stage ${x.stage ?? "not started"}${x.source ? `, from ${x.source}` : ""}]`,
      ),
    );
    const recent = l.done.filter((x) => {
      const t = x.finished ? Date.parse(x.finished) / 1000 : Number.NaN;
      return Number.isNaN(t) || t >= now - DONE_WINDOW_S;
    });
    for (const x of recent) ids.add(x.id);
    add(
      "Intents finished or dropped in the last 30 days",
      recent.slice(0, 60).map((x) => `- ${x.id} (${x.repo}) ${clip(x.title, 120)}`),
    );
  }
  const props = i.proposed.map((p) => {
    const id = i.intentsRepo ? `${i.intentsRepo}#${p.number}` : `#${p.number}`;
    ids.add(id);
    return `- ${id} (${p.intent?.repo ?? "?"}) ${clip(p.intent?.title ?? p.title, 120)}${p.proposer ? ` [by ${p.proposer}]` : ""}`;
  });
  add("Open proposals", props);

  const text = redact(
    `${out.join("\n").trim()}${cut.length ? `\n\n## Cut by the size limit\n${cut.map((c) => `- ${c}`).join("\n")}` : ""}`,
    config,
  );
  return { text, ids, cut };
}
