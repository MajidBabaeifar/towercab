// What the page shows, derived on the server (UI-56 to UI-64, UI-70, UI-71, UI-78; MET-29, MET-30). Pure
// functions over the database, the intent listing and what the loop knows; I/O only in the loaders.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { ProposedState } from "../github/proposed.ts";
import type { Clock } from "../handlers.ts";
import type { Home } from "../home.ts";
import type { Intent, IntentStore, Listing } from "../intents/types.ts";
import { finished, isWait, phaseOf, type Stage, waitInfo } from "../machine.ts";
import { dataOf, forIntent, type Mission } from "../mission.ts";
import { testGrantsOf } from "../pipeline/access.ts";
import { section } from "../pipeline/prtext.ts";
import { usualOwner } from "../repos.ts";
import { currentRisk, type RiskGate, riskWords } from "../risk.ts";
import { type Held, heldReleases, releaseLine, releaseTitle } from "../ship/releases.ts";
import { aheadIn, isAhead, isBuilding, isReady } from "../slots.ts";
import type { OwnerStep } from "../steps.ts";
import { proposedSection } from "./proposed.ts";
import type {
  Access,
  ActivityItem,
  ActivityKind,
  ActivityPage,
  AirspaceView,
  AttemptView,
  Card,
  CardKind,
  ExistingTestView,
  GroundStop,
  IntentPage,
  Lane,
  Overview,
  Phase,
  Plane,
  PrLink,
  ProblemView,
  PrState,
  PrView,
  Question,
  QueueItem,
  QueuePage,
  RiskView,
  Row,
  SpendView,
  StageFileView,
  StageId,
  StageMapView,
  StageNodeView,
  StateView,
  StationKey,
  TimelineItem,
  TopBar,
  UpNextView,
  VisitOutcome,
  VisitView,
  When,
} from "./view.ts";

/** A problem the loop knows about (LOOP-10 health, a failed self-update, the daily budget). */
export interface Problem {
  title: string;
  detail?: string;
  fix: string;
  since?: number;
  intent?: string;
  /** UI-109: the unreachable service in plain words ("GitHub"), set for a service fault. */
  service?: string;
  /** UI-109: this fault has paused new work (open for 15 minutes, LOOP-10). */
  pauses?: boolean;
}

/** Why the picker skips an intent (LOOP-5), worded by the page. */
export type Skip =
  | { kind: "paused" }
  | { kind: "ahead"; n: number; limit: number }
  | { kind: "cooling"; model: string; until: number }
  | { kind: "parked" }
  | { kind: "unreachable"; what: string }
  | { kind: "after"; intent: string }
  | { kind: "other"; text: string };

/** One entry of the picker's whole list (PRI-5), in pick order. */
export interface UpNext {
  intent: string;
  priority: number;
  skip: Skip | null;
}

export interface LogLine {
  at: number;
  text: string;
}

/** Everything the page reads; the loop provides it (the CLI too, read-only, UI-2). */
export interface UiSources {
  db: Db;
  store: IntentStore;
  config: Config;
  clock: Clock;
  home: Home;
  running: boolean;
  paused(): boolean;
  /** UI-111: when the owner paused (unix seconds); null for a pause made before the time was stored. */
  pausedAt(): number | null;
  problems(): Problem[];
  version(): { commit: string; behind: number | null };
  /** The picker's whole list; the overview shows the first 5. */
  upNext(): UpNext[];
  /** A PR's URL; `repo` is `owner/name`. */
  prUrl(repo: string, n: number): string;
  intentUrl(intent: Intent): string | null;
  /** UI-184: the open PRs that add an intent (LOOP-92); without it, none. */
  proposed?(): ProposedState;
  /** Recent loop log lines; without it, the first lines of `towercab.log`'s entries. */
  logs?(): LogLine[];
}

export interface Transition {
  id: number;
  mission: number;
  at: number;
  from_stage: Stage;
  event: string;
  to_stage: Stage;
  why: string | null;
}

const DAY = 86_400;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n: number) => String(n).padStart(2, "0");

/** `45 s`, `12 min`, `1 h 05 min`, `2 d 3 h`. */
export function duration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${pad(m % 60)} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** `$1.23`. */
export function money(usd: number): string {
  return `$${(Math.round(Math.max(0, usd) * 100) / 100).toFixed(2)}`;
}

/** `14:05` local. */
export function clock(at: number): string {
  const d = new Date(at * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `Mon 26 Oct 2026, 14:05:09` local, for hover. */
export function exactTime(at: number): string {
  const d = new Date(at * 1000);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clock(at)}:${pad(d.getSeconds())}`;
}

/** `YYYY-MM-DD` local. */
export function localDate(at: number): string {
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayOffset(at: number, now: number): number {
  const a = new Date(at * 1000);
  const b = new Date(now * 1000);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / (DAY * 1000));
}

function dateWords(at: number, now: number): string {
  const d = new Date(at * 1000);
  const year = new Date(now * 1000).getFullYear() === d.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** Relative words: `just now`, `12 min ago`, `3 h ago`, `yesterday 14:05`, `Mon 14:05`, `12 Oct`. */
export function ago(at: number, now: number): string {
  const diff = now - at;
  if (diff < -30) return until(at, now);
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} min ago`;
  const days = dayOffset(at, now);
  if (days === 0) return `${Math.floor(diff / 3600)} h ago`;
  if (days === 1) return `yesterday ${clock(at)}`;
  if (days < 7) return `${WEEKDAYS[new Date(at * 1000).getDay()]} ${clock(at)}`;
  return dateWords(at, now);
}

/** Future words: `in 12 min`, `at 14:05`, `tomorrow 09:00`, `12 Oct`. */
export function until(at: number, now: number): string {
  const diff = at - now;
  if (diff <= 30) return "now";
  if (diff < 3600) return `in ${Math.max(1, Math.round(diff / 60))} min`;
  const days = -dayOffset(at, now);
  if (days === 0) return `at ${clock(at)}`;
  if (days === 1) return `tomorrow ${clock(at)}`;
  return dateWords(at, now);
}

/** `14:05` today, `Mon 14:05` within a week, else `12 Oct`. */
export function shortTime(at: number, now: number): string {
  const days = dayOffset(at, now);
  if (days === 0) return clock(at);
  if (days > 0 && days < 7) return `${WEEKDAYS[new Date(at * 1000).getDay()]} ${clock(at)}`;
  return dateWords(at, now);
}

export function when(at: number, now: number): When {
  return { at, rel: ago(at, now), exact: exactTime(at), short: shortTime(at, now) };
}

/** PRI-3: `2i + u`, missing scores count as 3. */
export function priority(u: number | null, i: number | null): number {
  return 2 * (i ?? 3) + (u ?? 3);
}

/** `Opus`, `Sonnet`, or the name as given. */
export function modelName(model: string): string {
  for (const m of ["opus", "sonnet", "haiku"])
    if (model.toLowerCase().includes(m)) return m[0]!.toUpperCase() + m.slice(1);
  return model;
}

const STEP_WORDS: Record<Stage, string> = {
  pick: "Starting",
  design: "Writing the spec",
  "approval:spec": "Waiting for your spec review",
  plan: "Planning",
  "approval:plan": "Waiting for your plan review",
  build: "Building",
  verify: "Running checks",
  proof: "Proving the tests",
  publish: "Opening the PR",
  ci: "Waiting for CI",
  review: "Reviewing",
  gate: "Deciding",
  merge: "Merging",
  steps: "Waiting for your steps",
  deploy: "Waiting for the deploy",
  e2e: "Running e2e",
  rollback: "Rolling back",
  revert: "Reverting",
  "approval:merge": "Waiting for your code review",
  blocked: "Waiting for your answer",
  done: "Done",
  unverified: "Merged, not verified live",
  stopped: "Dropped",
};

/** UI-121: a stage in plain words, with a fix round's count and the repo hold. */
export function shipWords(m: Pick<Mission, "stage" | "step" | "data"> & { waiting?: string | null }): string {
  if (m.stage === "gate" && m.step === "hold") return "Repo on hold";
  // UI-161: the hold before the merge, and the stage after it, wait on the owner's steps.
  if (m.stage === "blocked" && m.waiting === "your steps first")
    return "Waiting for your steps before merging";
  const fixes = dataOf<{ ship?: { fixes?: number } }>(m as Mission).ship?.fixes ?? 0;
  const ship = ["deploy", "e2e", "rollback", "revert"].includes(m.stage);
  if (fixes > 0 && !ship && !isWait(m.stage) && !finished(m.stage))
    return `Fixing (${fixes} of 2): ${stepWords(m.stage).toLowerCase()}`;
  return stepWords(m.stage);
}

/** UI-56: a stage in plain words. */
export function stepWords(stage: Stage): string {
  return STEP_WORDS[stage] ?? stage;
}

const LABELS: Record<StateView["key"], StateView["label"]> = {
  needs: "Needs you",
  working: "Working",
  ci: "Waiting on CI",
  queued: "Queued",
  cooling: "Cooling down",
  paused: "Paused",
  stalled: "Stalled",
  upnext: "Up next",
  parked: "Parked",
  done: "Done",
  unverified: "Merged, not verified live",
  dropped: "Dropped",
};

export function state(key: StateView["key"], note: string | null = null): StateView {
  return { key, label: LABELS[key], note };
}

export interface StateOpts {
  /** When the mission entered its stage (its last move); default `updated`. */
  enteredAt?: number;
  /** The cooling model's `until` (unix s). */
  cooldownUntil?: number | null;
  config?: Config;
}

/** How long a stage may go without a move before it counts as stalled: 2 × its timeout, CI 2 h. */
export function stallAfter(stage: Stage, config?: Config): number {
  const a = config?.agent;
  const build = (a?.buildTimeoutMin ?? 60) * 60;
  const review = (a?.reviewTimeoutMin ?? 15) * 60;
  const check = (a?.checkTimeoutMin ?? 10) * 60;
  if (stage === "ci") return 2 * 3600;
  if (stage === "design" || stage === "plan" || stage === "build") return 2 * build;
  if (stage === "review" || stage === "gate") return 2 * review;
  return 2 * check;
}

const CARD_NOTES: Partial<Record<Stage, string>> = {
  "approval:spec": "Spec review",
  "approval:plan": "Plan review",
  "approval:merge": "Code review",
};

/** UI-56: the one state of a mission. */
export function stateOf(m: Mission, now: number, o: StateOpts = {}): StateView {
  if (m.stage === "stopped") return state("dropped");
  if (m.stage === "done") return state("done");
  if (m.stage === "unverified") return state("unverified");
  // UI-161: the owner's steps are a wait, before the merge (a hold at the gate) or after it (`steps`).
  if (m.waiting === "your steps first" || (m.stage === "steps" && m.waiting))
    return state("needs", "Your steps");
  if (isReady(m)) return state("queued", "ready to build");
  if (isWait(m.stage)) {
    const note = CARD_NOTES[m.stage] ?? (isQuestion(m.waiting) ? "Question" : "Blocked");
    return state("needs", note);
  }
  if (m.held) return state("paused", `before ${stepWords(m.stage).toLowerCase()}`);
  if (m.limit_model) {
    const u = o.cooldownUntil;
    return state("cooling", u ? `until ${clock(u)}` : null);
  }
  const since = now - (o.enteredAt ?? m.updated);
  if (since > stallAfter(m.stage, o.config)) return state("stalled", `for ${duration(since)}`);
  if (m.stage === "ci") return state("ci");
  return state("working");
}

/** LOOP-75: "Waiting for <id>: your steps" for a queued intent whose `after` intent isn't done yet. */
export function waitingFor(
  s: Pick<Snap, "listing" | "missions">,
  intent: Intent | null | undefined,
): string | null {
  if (!intent || intent.done || intent.stage !== null || intent.waiting !== null) return null;
  const blocker = intent.after.find((a) => !s.listing?.doneIds.has(a));
  if (!blocker) return null;
  const m = s.missions.find((x) => x.intent === blocker);
  const where = m ? (m.waiting ?? stepWords(m.stage).toLowerCase()) : "not started yet";
  return `Waiting for ${blocker}: ${where}.`;
}

/** UI-162: a finished intent is done, or merged but never checked live. */
export function finishedState(i: Pick<Intent, "verified">, note: string | null = null): StateView {
  return i.verified === "no" ? state("unverified", note) : state("done", note);
}

function skipState(s: Skip | null, parked: boolean): StateView {
  if (!s) return parked ? state("parked") : state("upnext");
  if (s.kind === "parked") return state("parked");
  if (s.kind === "paused") return state("paused");
  if (s.kind === "cooling") return state("cooling", `until ${clock(s.until)}`);
  return state("queued");
}

export interface Snap {
  now: number;
  listing: Listing | null;
  listError: string | null;
  intents: Map<string, Intent>;
  missions: Mission[];
  entered: Map<number, number>;
  cooldowns: Map<string, number>;
  paused: boolean;
}

export async function snapshot(src: UiSources): Promise<Snap> {
  const now = src.clock.now();
  let listing: Listing | null = null;
  let listError: string | null = null;
  try {
    listing = await src.store.list();
  } catch (e) {
    listError = (e as Error).message;
  }
  const intents = new Map<string, Intent>();
  for (const i of [...(listing?.done ?? []), ...(listing?.open ?? [])]) intents.set(i.id, i);
  const missions = src.db.all<Mission>(
    "SELECT * FROM missions WHERE stage NOT IN ('done','stopped','unverified') ORDER BY id",
  );
  const entered = new Map<number, number>();
  for (const r of src.db.all<{ mission: number; at: number }>(
    "SELECT mission, MAX(at) AS at FROM transitions WHERE mission IN (SELECT id FROM missions WHERE stage NOT IN ('done','stopped','unverified')) GROUP BY mission",
  )) {
    entered.set(r.mission, r.at);
  }
  const cooldowns = new Map<string, number>();
  for (const r of src.db.all<{ key: string; value: string }>(
    "SELECT key, value FROM meta WHERE key LIKE 'cooldown:%'",
  )) {
    try {
      const v = JSON.parse(r.value) as { until?: unknown };
      if (typeof v.until === "number") cooldowns.set(r.key.slice("cooldown:".length), v.until);
    } catch {
      // A bad row shows no reset time.
    }
  }
  return { now, listing, listError, intents, missions, entered, cooldowns, paused: src.paused() };
}

const titleOf = (s: Snap, id: string) => s.intents.get(id)?.title ?? id;

function missionState(s: Snap, m: Mission, src: UiSources): StateView {
  return stateOf(m, s.now, {
    enteredAt: s.entered.get(m.id) ?? m.created,
    cooldownUntil: m.limit_model ? (s.cooldowns.get(m.limit_model) ?? null) : null,
    config: src.config,
  });
}

type MissionData = {
  question?: Question;
  access?: Access;
  granted?: { tests?: { path: string; why: string }[] };
  testAllowed?: { path: string; why: string }[];
  refusedTests?: { path: string; why: string }[];
  /** The plain brief of the question asked (PIP-106). */
  brief?: string;
  design?: { brief?: string; pr?: string; concerns?: { what: string; why: string }[]; open?: string[] };
  plan?: { brief?: string; md?: string };
  build?: { brief?: string; notes?: string };
  review?: { summary?: string; brief?: string; details?: string } | null;
  runs?: { at: number; cost: number }[];
  doneByYou?: DoneNote;
};

/** UI-105: what the owner did from the page; display only, never moves the mission. */
export interface DoneNote {
  action: "merge" | "drop" | "retry";
  stage: string;
  pr: number;
  at: number;
}

/** UI-108: after this long without a move, the card stops promising one. */
export const STUCK_AFTER_S = 300;

const DONE_WORDS = { merge: "Merged", drop: "Dropped", retry: "Started over" } as const;

/** The note, if it still describes this mission's wait: same stage and same PR. */
export function validNote(m: Mission, pr: { number: number } | null): DoneNote | null {
  const n = dataOf<MissionData>(m).doneByYou;
  if (!n || !pr || n.stage !== m.stage || n.pr !== pr.number) return null;
  return n;
}

/** UI-105, UI-108: the "by you" line of a card and of a plane's card. */
export function doneOf(src: UiSources, m: Mission, now: number): Card["done"] {
  const n = validNote(m, currentPr(m, src.config, src.store.github()));
  if (!n) return null;
  const age = now - n.at;
  const stuck = age >= STUCK_AFTER_S;
  const text = stuck
    ? `${DONE_WORDS[n.action]} by you ${ago(n.at, now)}, but Towercab has not moved on yet`
    : `${DONE_WORDS[n.action]} by you · Towercab moves on within a minute`;
  return { action: n.action, text, stuck };
}

const nonEmpty = (s: string | null | undefined): string | null => (s?.trim() ? s.trim() : null);
const joinMd = (parts: (string | null | undefined)[]): string | null =>
  nonEmpty(parts.filter((p) => p?.trim()).join("\n\n"));

/** UI-126: the design's technical text: its spec summary, concerns and the questions it left open. */
function designDetails(d: MissionData): string | null {
  const concerns = d.design?.concerns ?? [];
  const open = d.design?.open ?? [];
  return joinMd([
    d.design?.pr,
    concerns.length
      ? `**Concerns the design raised**\n\n${concerns.map((c) => `- ${c.what}: ${c.why}`).join("\n")}`
      : null,
    open.length ? `**Questions it left to you**\n\n${open.map((q) => `- ${q}`).join("\n")}` : null,
  ]);
}

/** UI-126: the plan's technical text: its approach and risks. */
function planDetails(d: MissionData): string | null {
  const md = d.plan?.md ?? "";
  const approach = section(md, "Approach");
  const risks = section(md, "Risks");
  return joinMd([approach, risks ? `**Risks**\n\n${risks}` : null]);
}

/**
 * UI-126, UI-127: the plain brief and the technical text of what a mission waits on (or, for the
 * intent page, its latest stage): code → the review's brief (else the worker's), the review's
 * findings; plan → the plan's brief, its approach; spec → the design's brief, its concerns; a question
 * → the asker's brief, the question's context.
 */
export function textsOf(
  m: Mission,
  kind: CardKind,
  legacy = false,
): { brief: string | null; details: string | null } {
  const d = dataOf<MissionData>(m);
  switch (kind) {
    case "code": {
      const brief = nonEmpty(d.review?.brief) ?? nonEmpty(d.build?.brief);
      // Before briefs existed the review's summary led the card; it stays the card's fallback (UI-126),
      // never the intent page's, which calls its brief plain (UI-127).
      if (!brief) return { brief: legacy ? nonEmpty(d.review?.summary) : null, details: null };
      return { brief, details: nonEmpty(d.review?.details) ?? nonEmpty(d.review?.summary) };
    }
    case "plan":
      return { brief: nonEmpty(d.plan?.brief), details: planDetails(d) };
    case "spec":
      return { brief: nonEmpty(d.design?.brief), details: designDetails(d) };
    case "question": {
      const brief = nonEmpty(d.brief);
      return { brief, details: brief ? nonEmpty(d.question?.context) : null };
    }
    default:
      return { brief: null, details: null };
  }
}

/** PIP-118: the existing tests a mission's worker may change (the plan's, the owner's) and those refused. */
export function existingTestsOf(m: Mission): ExistingTestView[] {
  const d = dataOf<MissionData>(m);
  return [...testGrantsOf(d), ...(d.refusedTests ?? []).map((t) => ({ ...t, by: "refused" as const }))];
}

/**
 * AUT-20: the risk judged at `gate`, else the latest one (code, plan, spec), in plain words; only an
 * assessment of the current spec head, plan or diff counts (PIP-96).
 */
export function riskView(m: Mission, gate: RiskGate | null = null): RiskView | null {
  const order: RiskGate[] = gate ? [gate] : ["code", "plan", "spec"];
  for (const g of order) {
    const r = currentRisk(m, g);
    if (!r) continue;
    const w = riskWords(r);
    return {
      level: r.level,
      label: w.label,
      gate: g,
      blast: w.blast,
      door: w.door,
      certainty: w.certainty,
      summary: r.summary,
      raised: r.raised,
    };
  }
  return null;
}

function repoGithub(src: UiSources, repo: string): string | null {
  return src.config.repos.get(repo)?.github ?? null;
}

/** The PR a mission's phase is on: spec and code PRs in the repo, the plan PR in the intents repo. */
export function currentPr(
  m: Mission,
  config: Config,
  intentsGithub: string | null,
): { github: string; number: number; label: string } | null {
  const phase = phaseOf(m.stage, m.from_stage);
  const repo = config.repos.get(m.repo)?.github ?? null;
  if (phase === "spec" && m.spec_pr && repo) return { github: repo, number: m.spec_pr, label: "spec PR" };
  if (phase === "plan" && m.plan_pr && intentsGithub) {
    return { github: intentsGithub, number: m.plan_pr, label: "plan PR" };
  }
  if (phase === "code" && m.pr && repo) return { github: repo, number: m.pr, label: "code PR" };
  return null;
}

function prLink(src: UiSources, m: Mission): PrLink | null {
  const pr = currentPr(m, src.config, src.store.github());
  if (!pr) return null;
  const label = pr.label.charAt(0).toUpperCase() + pr.label.slice(1);
  return { number: pr.number, url: src.prUrl(pr.github, pr.number), label: `${label} #${pr.number}` };
}

/** Waits that ask the owner a question with options (PIP-41, PIP-95). */
const isQuestion = (w: string | null) => w === "answer the question" || w === "allow check writes";

function cardKind(m: Mission): CardKind {
  if (m.stage === "approval:spec") return "spec";
  if (m.stage === "approval:plan") return "plan";
  if (m.stage === "approval:merge") return "code";
  return isQuestion(m.waiting) ? "question" : "blocked";
}

const MERGE_LABELS: Partial<Record<CardKind, string>> = {
  spec: "Merge spec PR",
  plan: "Merge plan PR",
  code: "Merge PR",
};

const KIND_LABELS: Record<CardKind, string> = {
  spec: "Spec review",
  plan: "Plan review",
  code: "Code review",
  question: "Question",
  blocked: "Blocked",
  release: "Release PR",
};

/** SHIP-31: a held release PR as a "Needs you" card. It has no intent; its key is `release:<repo>`. */
export function releaseCard(h: Held, now: number): Card {
  return {
    intent: `release:${h.repo}`,
    title: releaseTitle(h),
    repo: h.repo,
    kind: "release",
    kindLabel: KIND_LABELS.release,
    ask: "Merge it yourself or close it. Towercab leaves this release alone.",
    since: when(h.since, now),
    brief: null,
    why: h.why,
    details: null,
    question: null,
    access: null,
    pr: { number: h.pr, url: `https://github.com/${h.github}/pull/${h.pr}`, label: "release PR" },
    actions: [],
    mergeLabel: null,
    done: null,
    addRepo: null,
  };
}

function askOf(waiting: string | null): string {
  if (!waiting) return "Towercab needs you.";
  try {
    return waitInfo(waiting).ask;
  } catch {
    return "Towercab needs you.";
  }
}

/** UI-58: the card for a mission waiting on the owner. */
export function missionCard(
  src: UiSources,
  m: Mission,
  intent: Intent | undefined,
  since: number | null,
  now: number,
): Card {
  const kind = cardKind(m);
  const d = dataOf<MissionData>(m);
  const pr = prLink(src, m);
  const approval = kind === "spec" || kind === "plan" || kind === "code";
  const note = intent?.sections.get("Towercab")?.trim() || null;
  const texts = textsOf(m, kind, true);
  let brief = texts.brief;
  if (!brief && !approval && !d.question && !pr) brief = note;
  // UI-126: an approval's reason is the plain gate reason; a blocked wait's reason is what Towercab
  // saw (a check's name, an error line): technical, so it folds under Details.
  const why = m.why && m.why !== brief ? m.why : null;
  const shownWhy = approval ? why : null;
  const details = joinMd([approval || why === d.question?.question ? null : why, texts.details]);
  const done = doneOf(src, m, now);
  const actions: Card["actions"] = done
    ? []
    : approval
      ? pr
        ? ["merge", "retry", "drop"]
        : ["retry", "drop"]
      : ["reply", "retry", "drop"];
  const gate = kind === "spec" || kind === "plan" ? kind : kind === "code" ? "code" : null;
  const risk = riskView(m, gate);
  const points = kind === "spec" ? (currentRisk(m, "spec")?.openPoints ?? []) : [];
  return {
    ...(risk ? { risk } : {}),
    ...(points.length ? { openPoints: points } : {}),
    intent: m.intent,
    title: intent?.title ?? m.intent,
    repo: m.repo,
    kind,
    kindLabel: KIND_LABELS[kind],
    ask: askOf(m.waiting),
    since: since === null ? null : when(since, now),
    brief,
    why: shownWhy,
    details,
    question: d.question ?? null,
    access: kind === "plan" ? (d.access ?? { domains: [], paths: [], tests: [] }) : null,
    pr,
    actions,
    mergeLabel: approval && pr && !done ? MERGE_LABELS[kind]! : null,
    done,
    addRepo: null,
  };
}

/** UI-58: a wait written only on the intent (unknown repo, bad after:); UI-131: "Add this repo". */
export function intentCard(i: Intent, config: Config): Card {
  const w = i.waiting ?? "";
  let why: string | null = null;
  let addRepo: Card["addRepo"] = null;
  if (w === "unknown repo" && config.repos.has(i.repo)) {
    why = `Towercab knows its repo “${i.repo}” now and queues it again within a minute.`;
  } else if (w === "unknown repo") {
    why = `Its repo “${i.repo}” isn't one Towercab knows yet. Check the GitHub repo below and press Add this repo, or change the intent's repo.`;
    const owner = usualOwner(config);
    addRepo = { name: i.repo, github: owner ? `${owner}/${i.repo}` : "" };
  } else if (w.startsWith("bad after:")) {
    why = `It waits for ${w.slice("bad after:".length).trim() || "an intent"}, which Towercab can't find or is dropped. Fix its after list.`;
  }
  return {
    intent: i.id,
    title: i.title,
    repo: i.repo,
    kind: "blocked",
    kindLabel: "Blocked",
    ask: askOf(w),
    since: null,
    brief: i.sections.get("Towercab")?.trim() || null,
    why,
    details: null,
    question: null,
    access: null,
    pr: null,
    actions: ["reply", "drop"],
    mergeLabel: null,
    done: null,
    addRepo,
  };
}

function phases(m: Mission): Phase[] {
  const p = phaseOf(m.stage, m.from_stage);
  const at = p === "spec" ? 0 : p === "plan" ? 1 : p === "code" ? 2 : 3;
  const status = (idx: number, had: boolean): Phase["status"] => {
    if (idx < at) return idx === 0 && !had ? "skipped" : "done";
    return idx === at ? "current" : "todo";
  };
  return [
    { label: "Spec", status: status(0, m.spec_pr !== null) },
    { label: "Plan", status: status(1, true) },
    { label: "Code", status: status(2, true) },
  ];
}

/** UI-59: a moving mission's row. */
export function missionRow(src: UiSources, s: Snap, m: Mission): Row {
  const entered = s.entered.get(m.id) ?? m.created;
  const ready = isReady(m);
  const holder = s.missions.find((x) => x.repo === m.repo && isBuilding(x));
  return {
    intent: m.intent,
    title: titleOf(s, m.intent),
    repo: m.repo,
    state: missionState(s, m, src),
    phases: phases(m),
    step: ready ? "Ready to build" : shipWords(m),
    inStep: duration(s.now - entered),
    cost: money(m.cost_usd),
    model: modelName(m.child_model ?? m.model),
    behind: ready
      ? holder
        ? `Ready to build, behind “${titleOf(s, holder.intent)}”.`
        : "Ready to build; it starts on the next pass."
      : null,
  };
}

/** UI-61: why an intent doesn't start now. */
export function skipWords(skip: Skip | null, titles: (id: string) => string, now: number): string | null {
  if (!skip) return null;
  switch (skip.kind) {
    case "paused":
      return "New work starts when you resume.";
    case "ahead":
      return `${skip.n} intents are already ahead of build in this repo; it starts when one has a place free, or when you start it.`;
    case "cooling":
      return `${modelName(skip.model)} is cooling down after a usage limit; it can start ${until(skip.until, now)}.`;
    case "parked":
      return "Raise its urgency or importance to run it.";
    case "unreachable":
      return `${skip.what} can't be reached; it starts once it can.`;
    case "after":
      return `Waits for “${titles(skip.intent)}” to be done.`;
    case "other":
      return skip.text;
  }
}

function queuedRow(s: Snap, u: UpNext): Row {
  const i = s.intents.get(u.intent);
  return {
    intent: u.intent,
    title: i?.title ?? u.intent,
    repo: i?.repo ?? "",
    state: skipState(u.skip, false),
    phases: [
      { label: "Spec", status: "todo" },
      { label: "Plan", status: "todo" },
      { label: "Code", status: "todo" },
    ],
    step: "Not started",
    inStep: "",
    cost: money(0),
    model: modelName(i?.model ?? ""),
    behind: skipWords(u.skip, (id) => titleOf(s, id), s.now) ?? "Starts when a slot is free.",
  };
}

/** UI-78: where a mission's plane sits on the airspace line. */
export function stationOf(
  m: Pick<Mission, "stage" | "from_stage"> & { waiting?: string | null },
): StationKey {
  // UI-161: a change held by steps before the merge waits at the gate's owner station.
  if (m.stage === "blocked" && m.waiting === "your steps first") return "code-review";
  // UI-120: shipping, and a wait that came out of shipping, sit at the ship stations.
  const at = m.stage === "blocked" && m.from_stage ? m.from_stage : m.stage;
  if (at === "steps" || at === "deploy" || at === "rollback") return "deploy";
  if (at === "e2e" || at === "revert") return "e2e";
  if (m.stage === "approval:spec") return "spec-review";
  if (m.stage === "approval:plan") return "plan-review";
  if (m.stage === "approval:merge") return "code-review";
  if (m.stage === "ci") return "ci";
  const p = phaseOf(m.stage, m.from_stage);
  return p === "spec" || p === "plan" ? p : "code";
}

/** UI-125: a plane rolling back or reverting, or one in a fix round. */
export function shipMark(m: Pick<Mission, "stage" | "from_stage" | "data">): Plane["ship"] {
  const at = m.stage === "blocked" && m.from_stage ? m.from_stage : m.stage;
  if (at === "rollback" || at === "revert") return { kind: at, mark: "↩" };
  const fixes = dataOf<{ ship?: { fixes?: number } }>(m as Mission).ship?.fixes ?? 0;
  return fixes > 0 && !finished(m.stage) ? { kind: "fix", mark: `fix ${fixes}/2` } : undefined;
}

/** UI-125: the first card line of a plane going back: which suite went red, and where it goes. */
function backWords(m: Mission): string | null {
  const ship = dataOf<{ ship?: { red?: { suite: string }; target?: string } }>(m).ship;
  return ship?.red && ship.target ? `${ship.red.suite} red · back to ${ship.target.slice(0, 7)}` : null;
}

const SHIP_WEEK = 7 * 86_400;

const STATIONS: StationKey[] = [
  "parked",
  "queue",
  "gate",
  "spec",
  "spec-review",
  "plan",
  "plan-review",
  "code",
  "ci",
  "code-review",
  "deploy",
  "e2e",
  "landed",
];

/** UI-110: the card line of a plane waiting at merge during a ground stop. */
const heldWords = (stop: GroundStop) =>
  stop.kind === "owner" ? "Held until you resume" : `Held until ${stop.service} is reachable again`;

const NOT_STARTED: Phase[] = [
  { label: "Spec", status: "todo" },
  { label: "Plan", status: "todo" },
  { label: "Code", status: "todo" },
];

/** UI-109: why the airspace is stopped, if it is; the owner's pause wins over a service pause. */
export function groundStopOf(src: UiSources, s: Snap): GroundStop | null {
  if (s.paused) {
    const since = src.pausedAt();
    return {
      kind: "owner",
      text:
        since === null
          ? "GROUND STOP · paused"
          : `GROUND STOP · paused since ${shortTime(since, s.now)} by you`,
      since,
      canResume: src.running,
    };
  }
  const fault = src.problems().find((p) => p.pauses && p.service);
  if (!fault) return null;
  return {
    kind: "health",
    text: `GROUND STOP · can't reach ${fault.service}`,
    service: fault.service!,
    reason: fault.detail ?? "",
  };
}

/** UI-78: every open intent as a plane at its station, and what landed today. */
export function airspaceOf(src: UiSources, s: Snap, list: UpNext[], needs: number): AirspaceView {
  const stop = groundStopOf(src, s);
  const planes: Plane[] = [];
  const seen = new Set<string>();
  for (const m of s.missions) {
    const row = missionRow(src, s, m);
    const waited = duration(s.now - (s.entered.get(m.id) ?? m.created));
    const mark = shipMark(m);
    const back = mark && mark.kind !== "fix" ? backWords(m) : null;
    planes.push({
      intent: m.intent,
      title: row.title,
      repo: m.repo,
      state: row.state,
      station: isReady(m) ? "code" : stationOf(m),
      canStart: false,
      lines: isReady(m)
        ? [row.behind ?? "Ready to build", `${row.cost} · ${row.model}`]
        : isWait(m.stage)
          ? [doneOf(src, m, s.now)?.text ?? askOf(m.waiting), `Waiting ${waited} · ${row.cost}`]
          : [back ?? `${row.step} · ${row.inStep}`, `${row.cost} · ${row.model}`],
      phases: row.phases,
      ...(mark ? { ship: mark } : {}),
      ...(m.held && stop ? { held: heldWords(stop) } : {}),
    });
    seen.add(m.intent);
  }
  for (const i of s.listing?.open ?? []) {
    if (!i.waiting || seen.has(i.id)) continue;
    planes.push({
      intent: i.id,
      title: i.title,
      repo: i.repo,
      state: state("needs", "Blocked"),
      station: "gate",
      lines: [askOf(i.waiting), "Not started"],
      canStart: false,
      phases: NOT_STARTED,
    });
    seen.add(i.id);
  }
  let place = 0;
  for (const u of list) {
    if (seen.has(u.intent)) continue;
    const i = s.intents.get(u.intent);
    const parked = u.skip?.kind === "parked";
    const why = skipWords(u.skip, (id) => titleOf(s, id), s.now);
    if (!parked) place++;
    planes.push({
      intent: u.intent,
      title: i?.title ?? u.intent,
      repo: i?.repo ?? "",
      state: parked ? state("parked") : skipState(u.skip, false),
      station: parked ? "parked" : u.skip ? "queue" : "gate",
      lines: parked
        ? [`Priority ${u.priority} · below the cutoff`, why ?? ""]
        : [`#${place} in line · priority ${u.priority}`, why ?? "Starts when a slot is free."],
      canStart: src.running && !parked,
      phases: NOT_STARTED,
    });
  }
  planes.sort((a, b) => STATIONS.indexOf(a.station) - STATIONS.indexOf(b.station));

  const today = localDate(s.now);
  const dropped = s.listing?.droppedIds ?? new Set<string>();
  const finishedAt = (i: Intent) => (i.finished ? Date.parse(i.finished) / 1000 : Number.NaN);
  const landed = (s.listing?.done ?? [])
    .filter((i) => i.stage === "done" && !dropped.has(i.id))
    .filter((i) => Number.isFinite(finishedAt(i)) && localDate(finishedAt(i)) === today)
    .sort((a, b) => finishedAt(b) - finishedAt(a));

  const count = (k: StationKey[]) =>
    planes.filter((p) => k.includes(p.station) && p.state.key !== "needs").length;
  const counts = {
    parked: count(["parked"]),
    queued: count(["queue", "gate"]),
    flying: s.missions.filter((m) => !isWait(m.stage)).length,
    needs,
    landed: landed.length,
  };
  const needWord = `need${needs === 1 ? "s" : ""} you`;
  const stopWords = stop ? `${stop.text.replace("GROUND STOP · ", "Ground stop: ")}. ` : "";
  return {
    stop,
    planes,
    landed: {
      count: landed.length,
      cost: money(landed.reduce((t, i) => t + (i.cost ?? 0), 0)),
      agentTime: duration(landed.reduce((t, i) => t + (i.agentTime ?? 0), 0)),
      recent: landed.slice(0, 3).map((i) => ({ intent: i.id, title: i.title, repo: i.repo })),
    },
    counts,
    ship:
      planes.some((p) => p.station === "deploy" || p.station === "e2e") ||
      src.db.get(
        "SELECT 1 FROM transitions WHERE to_stage = 'deploy' AND at > ? LIMIT 1",
        s.now - SHIP_WEEK,
      ) !== undefined,
    countsText: `${counts.flying} in flight · ${needs} ${needWord} · ${counts.landed} landed today`,
    summary:
      `${stopWords}Airspace: ${counts.parked} parked, ${counts.queued} queued, ${counts.flying} in flight, ` +
      `${needs} ${needWord}, ${counts.landed} landed today.`,
  };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

function problemsOf(src: UiSources, s: Snap, todaySpend: number): ProblemView[] {
  const out: ProblemView[] = [];
  for (const [n, p] of src.problems().entries()) {
    out.push({
      key: `loop:${n}`,
      title: p.title,
      detail: p.detail ?? (p.since ? `Since ${ago(p.since, s.now)}.` : null),
      fix: p.fix,
      intent: p.intent ?? null,
      tone: "error",
      code: false,
    });
  }
  const budget = src.config.agent.dailyBudgetUsd;
  if (budget !== null && todaySpend >= budget && !out.some((p) => /budget/i.test(p.title))) {
    out.push({
      key: "budget",
      title: `Today's budget is used up: ${money(todaySpend)} of ${money(budget)}.`,
      detail: null,
      fix: "New work starts again at midnight. Raise the daily budget in the config to go on now.",
      intent: null,
      tone: "warn",
      code: false,
    });
  }
  if (s.listError) {
    out.push({
      key: "intents",
      title: "Towercab can't read the intents repo.",
      detail: s.listError,
      fix: "Check that the intents checkout exists and can be pulled.",
      intent: null,
      tone: "error",
      code: true,
    });
  }
  for (const m of s.missions) {
    const st = missionState(s, m, src);
    if (st.key === "stalled") {
      out.push({
        key: `stalled:${m.id}`,
        title: `“${titleOf(s, m.intent)}” has not moved for ${duration(s.now - (s.entered.get(m.id) ?? m.created))}.`,
        detail: `It is at ${stepWords(m.stage).toLowerCase()}, which usually takes less than ${duration(stallAfter(m.stage, src.config) / 2)}.`,
        fix: "Open it to see its last step and logs, or start it over.",
        intent: m.intent,
        tone: "error",
        code: false,
      });
    }
  }
  if (s.missions.length > 0) {
    const ids = s.missions.map((m) => m.id);
    const reds = src.db.all<{ mission: number; why: string | null }>(
      `SELECT mission, why FROM transitions WHERE event = 'red' AND mission IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
      ...ids,
    );
    const last = new Map<number, (string | null)[]>();
    for (const r of reds) last.set(r.mission, [...(last.get(r.mission) ?? []), r.why].slice(-2));
    for (const m of s.missions) {
      const two = last.get(m.id);
      if (two?.length === 2 && two[0] && two[0] === two[1]) {
        out.push({
          key: `repeat:${m.id}`,
          title: `The same check failed twice on “${titleOf(s, m.intent)}”.`,
          detail: two[0],
          fix: "Look at the check's log on its page; reply with a hint or start it over.",
          intent: m.intent,
          tone: "warn",
          code: true,
        });
      }
    }
  }
  const costs = src.db
    .all<{ cost_usd: number }>("SELECT cost_usd FROM missions WHERE stage = 'done' ORDER BY id DESC LIMIT 20")
    .map((r) => r.cost_usd);
  if (costs.length >= 3) {
    const med = median(costs);
    for (const m of s.missions) {
      if (med > 0 && m.cost_usd > 3 * med) {
        out.push({
          key: `cost:${m.id}`,
          title: `“${titleOf(s, m.intent)}” has cost ${money(m.cost_usd)}, over 3 × the usual ${money(med)}.`,
          detail: null,
          fix: "Check that it isn't going in circles; drop it or narrow the intent if so.",
          intent: m.intent,
          tone: "warn",
          code: false,
        });
      }
    }
  }
  for (const u of s.listing?.unreadable ?? []) {
    out.push({
      key: `unreadable:${u.path}`,
      title: `An intent file can't be read: ${u.path}`,
      detail: u.reason,
      fix: "Fix the file in the intents repo; Towercab reads it again within a minute.",
      intent: null,
      tone: "warn",
      code: false,
    });
  }
  return out;
}

export interface Spend {
  today: number;
  week: number;
  /** The last 7 local days, oldest first, today last. */
  days: { date: string; cost: number }[];
}

/** MET-29: run costs (`data.runs`) summed by local day: today and the last 7 days. */
export function spend(db: Db, now: number): Spend {
  const byDay = new Map<string, number>();
  for (const r of db.all<{ data: string }>("SELECT data FROM missions WHERE updated >= ?", now - 8 * DAY)) {
    let runs: unknown;
    try {
      runs = (JSON.parse(r.data) as { runs?: unknown }).runs;
    } catch {
      continue;
    }
    if (!Array.isArray(runs)) continue;
    for (const run of runs as { at?: unknown; cost?: unknown }[]) {
      if (typeof run?.at !== "number" || typeof run.cost !== "number" || run.at > now) continue;
      const k = localDate(run.at);
      byDay.set(k, (byDay.get(k) ?? 0) + run.cost);
    }
  }
  const days: Spend["days"] = [];
  const t = new Date(now * 1000);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - i, 12);
    const k = localDate(d.getTime() / 1000);
    days.push({ date: k, cost: byDay.get(k) ?? 0 });
  }
  return { today: days[6]!.cost, week: days.reduce((a, d) => a + d.cost, 0), days };
}

/** MET-29: the daily budget is set and today's spend reached it. */
export function budgetReached(db: Db, config: Config, now: number): boolean {
  const b = config.agent.dailyBudgetUsd;
  return b !== null && spend(db, now).today >= b;
}

function spendView(sp: Spend, budget: number | null): SpendView {
  return {
    today: money(sp.today),
    week: money(sp.week),
    budget: budget === null ? null : money(budget),
    todayUsd: sp.today,
    budgetUsd: budget,
    days: sp.days.map((d) => {
      const at = new Date(`${d.date}T12:00:00`).getTime() / 1000;
      return {
        date: d.date,
        label: WEEKDAYS[new Date(at * 1000).getDay()]!,
        cost: d.cost,
        text: money(d.cost),
      };
    }),
  };
}

export interface StepTime {
  stage: Stage;
  words: string;
  secs: number;
  /** Waiting on the owner, not Towercab's own time. */
  owner: boolean;
}

/**
 * MET-30: the gaps between a mission's consecutive moves, grouped by stage (first seen first). `start`
 * (the mission's `created`) adds the time before the first move; `now` the time in the current stage.
 */
export function stepTimes(
  ts: Pick<Transition, "at" | "from_stage" | "to_stage">[],
  o: { start?: number; now?: number } = {},
): { steps: StepTime[]; towercab: number; owner: number } {
  const sorted = [...ts].sort((a, b) => a.at - b.at);
  const segs: [Stage, number][] = [];
  if (sorted.length && o.start !== undefined) segs.push([sorted[0]!.from_stage, sorted[0]!.at - o.start]);
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const next = sorted[i + 1];
    if (next) segs.push([t.to_stage, next.at - t.at]);
    else if (o.now !== undefined && !finished(t.to_stage)) segs.push([t.to_stage, o.now - t.at]);
  }
  const steps: StepTime[] = [];
  let towercab = 0;
  let owner = 0;
  for (const [stage, secs] of segs) {
    if (secs < 0) continue;
    let s = steps.find((x) => x.stage === stage);
    if (!s) {
      s = { stage, words: stepWords(stage), secs: 0, owner: isWait(stage) };
      steps.push(s);
    }
    s.secs += secs;
    if (s.owner) owner += secs;
    else towercab += secs;
  }
  return { steps, towercab, owner };
}

function healthOf(
  src: UiSources,
  problems: ProblemView[],
  paused: boolean,
): { health: TopBar["health"]; note: string } {
  if (!src.running)
    return {
      health: "Not running",
      note: "Towercab isn't running, so nothing moves. Start it with towercab up.",
    };
  if (problems.some((p) => p.tone === "error"))
    return { health: "Problem", note: "Something needs a look: see Problems." };
  if (paused) return { health: "Paused", note: "Nothing new starts until you resume." };
  const draining = src.db.meta("draining");
  if (draining) return { health: "Running", note: `Draining for update to ${draining}.` };
  return { health: "Running", note: "Towercab is running." };
}

function versionText(v: { commit: string; behind: number | null }): TopBar["version"] {
  const behind =
    v.behind === null
      ? null
      : v.behind === 0
        ? "up to date"
        : `${v.behind} commit${v.behind === 1 ? "" : "s"} behind main`;
  return { commit: v.commit.slice(0, 7), behind };
}

/** A short hash of what is shown, so the page knows when to refetch (UI-65, UI-67). */
export function versionOf(value: unknown, extra = ""): string {
  return createHash("sha1").update(JSON.stringify(value)).update(extra).digest("hex").slice(0, 12);
}

export function dbMark(db: Db): string {
  const t = db.get<{ n: number | null }>("SELECT MAX(id) AS n FROM transitions")?.n ?? 0;
  const c = db.get<{ n: number | null }>("SELECT MAX(id) AS n FROM commands")?.n ?? 0;
  const u = db.get<{ n: number | null }>("SELECT MAX(updated) AS n FROM missions")?.n ?? 0;
  // A repo added, removed or changed (LOOP-68) shows without anything else moving.
  const r =
    db.get<{ r: string | null }>(
      "SELECT group_concat(name || ' ' || base || ' ' || workers || ' ' || ahead, ',') AS r FROM repos",
    )?.r ?? "";
  // A feature-list backfill asked for, started, done or failed (UI-144) shows on open pages too.
  const f =
    db.get<{ f: string | null }>(
      "SELECT group_concat(key || '=' || value, ',') AS f FROM meta WHERE key LIKE 'features:%'",
    )?.f ?? "";
  return `${t}:${c}:${u}:${r}:${f}`;
}

/** The overview's data (`GET /api/state`). */
export async function overview(src: UiSources): Promise<Overview> {
  const s = await snapshot(src);
  const sp = spend(src.db, s.now);
  const needs: (Card & { order: number })[] = [];
  const working: Row[] = [];
  const ready: Row[] = [];
  for (const m of s.missions) {
    if (isReady(m)) {
      ready.push(missionRow(src, s, m));
    } else if (isWait(m.stage)) {
      const since = s.entered.get(m.id) ?? m.created;
      needs.push({ ...missionCard(src, m, s.intents.get(m.intent), since, s.now), order: since });
    } else {
      working.push(missionRow(src, s, m));
    }
  }
  const withMission = new Set(s.missions.map((m) => m.intent));
  for (const i of s.listing?.open ?? []) {
    if (i.waiting && !withMission.has(i.id))
      needs.push({ ...intentCard(i, src.config), order: Number.POSITIVE_INFINITY });
  }
  for (const h of heldReleases(src.db, s.now)) {
    if (h.card) needs.push({ ...releaseCard(h, s.now), order: h.since });
  }
  needs.sort((a, b) => a.order - b.order);
  const list = src.upNext().filter((u) => !withMission.has(u.intent));
  const queued = [...ready, ...list.filter((u) => u.skip?.kind !== "parked").map((u) => queuedRow(s, u))];
  const upNext: UpNextView[] = list.slice(0, 5).map((u) => {
    const i = s.intents.get(u.intent);
    return {
      intent: u.intent,
      title: i?.title ?? u.intent,
      repo: i?.repo ?? "",
      priority: u.priority,
      state: skipState(u.skip, false),
      reason: skipWords(u.skip, (id) => titleOf(s, id), s.now),
      canStart: src.running && u.skip?.kind !== "parked",
    };
  });
  const problems = problemsOf(src, s, sp.today);
  const { health, note } = healthOf(src, problems, s.paused);
  const counts = [
    `${needs.length} need${needs.length === 1 ? "s" : ""} you`,
    `${working.length} working`,
    `${queued.length} queued`,
  ];
  const budget = src.config.agent.dailyBudgetUsd;
  const top: TopBar = {
    health,
    healthNote: note,
    needs: needs.length,
    working: working.length,
    queued: queued.length,
    countsText: counts.join(" · "),
    spendToday: money(sp.today),
    budget: budget === null ? null : `of ${money(budget)}`,
    overBudget: budget !== null && sp.today >= budget,
    version: versionText(src.version()),
    paused: s.paused,
    readOnly: !src.running,
    banner: src.running ? null : "Towercab isn't running: this page is read-only. Start it with towercab up.",
  };
  const body = {
    top,
    ...(src.proposed ? { proposed: proposedSection(src) } : {}),
    needs: needs.map(({ order: _, ...c }) => c),
    problems,
    working,
    queued,
    upNext,
    spend: spendView(sp, budget),
    airspace: airspaceOf(src, s, list, needs.length),
  };
  return { version: versionOf(body, `${dbMark(src.db)}:${s.listing?.head ?? ""}`), ...body };
}

const prNumber = (url: string | null) => {
  const m = url ? /\/pull\/(\d+)/.exec(url) : null;
  return m ? Number(m[1]) : null;
};

/** The phase a mission reached, looking through `stopped` to where it stopped. */
function reachedPhase(m: Mission, ts: Transition[]): ReturnType<typeof phaseOf> {
  if (m.stage !== "stopped") return phaseOf(m.stage, m.from_stage);
  const last = ts.filter((t) => t.mission === m.id && t.to_stage === "stopped").pop();
  return last ? phaseOf(last.from_stage, null) : "spec";
}

function prViews(src: UiSources, i: Intent | null, m: Mission | null, ts: Transition[]): PrView[] {
  const repo = m ? repoGithub(src, m.repo) : i ? repoGithub(src, i.repo) : null;
  const intentsRepo = src.store.github();
  const phase = m ? reachedPhase(m, ts) : i?.done ? "done" : "spec";
  const dropped = m?.stage === "stopped" || i?.stage === "dropped";
  const order = ["spec", "plan", "code", "done"];
  const at = order.indexOf(phase === "dropped" ? "spec" : phase);
  const one = (
    label: PrView["label"],
    idx: number,
    num: number | null,
    field: string | null,
    gh: string | null,
  ): PrView => {
    const n = num ?? prNumber(field);
    const url = n !== null && gh ? src.prUrl(gh, n) : field;
    let st: PrState;
    if (n !== null || field) {
      if (at > idx || phase === "done") st = "merged";
      else if (dropped) st = "closed";
      else st = "open";
    } else if (at > idx || phase === "done" || dropped) st = "not needed";
    else st = "not yet";
    return { label, state: st, number: n, url: url ?? null };
  };
  // UI-124: past Merging the code PR is merged; fix rounds keep the PRs they replaced.
  const where = m ? (m.stage === "blocked" ? m.from_stage : m.stage) : null;
  const shipping = where !== null && SHIP_STAGES.includes(where);
  type Ship = { prs?: number[]; revert?: { pr: number | null; sha: string | null } };
  const ship = m ? dataOf<{ ship?: Ship }>(m).ship : undefined;
  const earlier = ship?.prs ?? [];
  const tile = (n: number, label: PrView["label"], state: PrState = "merged"): PrView => ({
    label,
    state,
    number: n,
    url: repo ? src.prUrl(repo, n) : null,
  });
  const fixLabel = (k: number): PrView["label"] => (k === 0 ? "Code" : `Fix ${k}`);
  const code = one(fixLabel(earlier.length), 2, m?.pr ?? null, i?.pr ?? null, repo);
  const revert = ship?.revert ?? null;
  return [
    one("Spec", 0, m?.spec_pr ?? null, i?.specPr ?? null, repo),
    one("Plan", 1, m?.plan_pr ?? null, i?.planPr ?? null, intentsRepo),
    ...earlier.map((n, k) => tile(n, fixLabel(k))),
    shipping && code.number !== null ? { ...code, state: "merged" } : code,
    ...(revert?.pr ? [tile(revert.pr, "Revert", revert.sha ? "merged" : "open")] : []),
  ];
}

const SHIP_STAGES: (Stage | null)[] = ["steps", "deploy", "e2e", "rollback", "revert"];

const ENTER_WORDS: Partial<Record<Stage, string>> = {
  pick: "Picked up",
  design: "Started writing the spec",
  plan: "Started planning",
  build: "Started building",
  verify: "Running the checks",
  proof: "Proving the tests fail without the change",
  publish: "Opening the PR",
  ci: "Waiting for CI",
  review: "Reviewing the change",
  gate: "Deciding whether it can merge",
  merge: "Merging",
  "approval:spec": "Asked you to review the spec PR",
  "approval:plan": "Asked you to review the plan",
  "approval:merge": "Asked you to review and merge the code PR",
  blocked: "Stopped and asked you",
  steps: "Merged; waiting for your steps",
  unverified: "Merged, not verified live",
  done: "Done: the code PR is merged and works live",
};

/** UI-62: one move in plain words. */
export function moveWords(t: Pick<Transition, "from_stage" | "event" | "to_stage" | "why">): string {
  const to = t.to_stage;
  const from = stepWords(t.from_stage).toLowerCase();
  switch (t.event) {
    case "red":
      return `${stepWords(t.from_stage)} failed; back to building`;
    case "spec_merged":
      return "Spec PR merged; planning starts";
    case "plan_merged":
      return "Plan PR merged; building starts";
    case "code_merged":
      return "Code PR merged: done";
    case "closed":
      return "Dropped: the PR was closed";
    case "intent_removed":
      return "Dropped: the intent file was removed";
    case "feedback":
      return `Your feedback sent it back to ${stepWords(to).toLowerCase()}`;
    case "answered":
      return `You answered; back to ${stepWords(to).toLowerCase()}`;
    case "conflict":
      return "The PR has a conflict; rebuilding";
    case "head_moved":
      return "The PR changed; waiting for CI again";
    case "retry_fresh":
      return "Starting over with a fresh attempt";
    case "timeout":
      return `${stepWords(t.from_stage)} timed out`;
    case "bad_result":
      return `${stepWords(t.from_stage)} ran again`;
    case "crash":
      return `Towercab crashed while ${from}`;
  }
  if (to === "stopped") return t.why?.startsWith("replaced by") ? "Replaced by a fresh attempt" : "Dropped";
  return ENTER_WORDS[to] ?? `Moved to ${stepWords(to).toLowerCase()}`;
}

const ERROR_EVENTS = new Set(["red", "crash", "timeout", "bad_result", "env_fail"]);

function moveKind(t: Pick<Transition, "event" | "to_stage">): ActivityKind {
  if (isWait(t.to_stage)) return "wait";
  if (ERROR_EVENTS.has(t.event)) return "error";
  return "move";
}

export const RUN_NAME = /^[A-Za-z0-9._-]+$/;

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface NodeDef {
  id: StageId;
  name: string;
  /** The machine stage it shows, and the folder under `runs/<id>/` that holds its files. */
  stage: Stage | null;
  folder: string | null;
  owner: boolean;
  /** A ship stage (UI-123): listed only when the attempt visited it. */
  ship?: boolean;
}

/** UI-72: the map's stages in pipeline order, in the words of UI-56. */
const NODES: NodeDef[] = [
  { id: "design", name: "Writing the spec", stage: "design", folder: "design", owner: false },
  { id: "spec_review", name: "Your spec review", stage: "approval:spec", folder: null, owner: true },
  { id: "plan", name: "Planning", stage: "plan", folder: "plan", owner: false },
  { id: "plan_review", name: "Your plan review", stage: "approval:plan", folder: null, owner: true },
  { id: "build", name: "Building", stage: "build", folder: "build", owner: false },
  { id: "verify", name: "Running checks", stage: "verify", folder: "verify", owner: false },
  { id: "proof", name: "Proving the tests", stage: "proof", folder: "proof", owner: false },
  { id: "publish", name: "Opening the PR", stage: "publish", folder: "publish", owner: false },
  { id: "ci", name: "CI", stage: "ci", folder: "ci", owner: false },
  { id: "review", name: "Reviewing", stage: "review", folder: "review", owner: false },
  { id: "gate", name: "Deciding", stage: "gate", folder: "gate", owner: false },
  { id: "code_review", name: "Your code review", stage: "approval:merge", folder: null, owner: true },
  { id: "merge", name: "Merging", stage: "merge", folder: "merge", owner: false },
  // UI-123: the ship stages, listed only when visited.
  // UI-161: the owner's steps after the merge, listed only when visited.
  { id: "steps", name: "Your steps", stage: "steps", folder: null, owner: true, ship: true },
  { id: "deploy", name: "Deploying", stage: "deploy", folder: null, owner: false, ship: true },
  { id: "e2e", name: "e2e tests", stage: "e2e", folder: "e2e", owner: false, ship: true },
  { id: "rollback", name: "Rolling back", stage: "rollback", folder: null, owner: false, ship: true },
  { id: "revert", name: "Reverting", stage: "revert", folder: null, owner: false, ship: true },
  { id: "answer", name: "Your answer", stage: "blocked", folder: null, owner: true },
  { id: "other", name: "Other", stage: null, folder: null, owner: false },
];

const NODE_OF_STAGE = new Map<string, NodeDef>(NODES.filter((n) => n.stage).map((n) => [n.stage!, n]));
const NODE_OF_FOLDER = new Map<string, NodeDef>(NODES.filter((n) => n.folder).map((n) => [n.folder!, n]));
const NODE_BY_ID = new Map<StageId, NodeDef>(NODES.map((n) => [n.id, n]));
const NODE_INDEX = new Map<StageId, number>(NODES.map((n, i) => [n.id, i]));

/** LOOP-42: the stage a flat file (written before the stage folders) belongs to, by its old name. */
const FLAT_PREFIX: Record<string, StageId> = {
  design: "design",
  plan: "plan",
  build: "build",
  worker: "build",
  verify: "verify",
  checks: "verify",
  shots: "verify",
  setup: "verify",
  proof: "proof",
  publish: "publish",
  ci: "ci",
  review: "review",
  gate: "gate",
  merge: "merge",
};

export function flatStage(name: string): StageId {
  const parts = name.toLowerCase().split(/[-.]/);
  const first = parts[0] ?? "";
  if (first === "settings" || first === "system") return FLAT_PREFIX[parts[1] ?? ""] ?? "other";
  if (first === "guard") return "build";
  return FLAT_PREFIX[first] ?? "other";
}

function kindOf(name: string): { kind: string; details: boolean } {
  if (/^(settings|system)-|^guard\.json$/.test(name)) return { kind: "Details", details: true };
  if (/\.prompt$/.test(name)) return { kind: "Prompt sent", details: false };
  if (/\.err$/.test(name)) return { kind: "Errors", details: false };
  if (/^(worker|design|plan|review|risk|score)-\d+\.json$/.test(name))
    return { kind: "Claude's answer", details: false };
  if (/\.log$/.test(name)) return { kind: "Check output", details: false };
  return { kind: "File", details: false };
}

interface FoundFile {
  node: StageId;
  rel: string;
  name: string;
  bytes: number;
  mtime: number;
  /** A folder of screenshots: its image count. */
  images?: number;
}

function scanDir(dir: string, prefix: string, node: (name: string) => StageId, out: FoundFile[]): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (!RUN_NAME.test(name) || name.startsWith(".")) continue;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(join(dir, name));
    } catch {
      continue;
    }
    if (st.isDirectory() && /^shots-\d+$/.test(name)) {
      let images = 0;
      try {
        images = readdirSync(join(dir, name)).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).length;
      } catch {
        // Unreadable: no images to count.
      }
      if (images)
        out.push({
          node: node(name),
          rel: `${prefix}${name}`,
          name,
          bytes: 0,
          mtime: st.mtimeMs / 1000,
          images,
        });
      continue;
    }
    // Symlinks, images, empty files and folders are not listed (UI-72).
    if (!st.isFile() || st.size === 0 || /\.(png|jpe?g|gif|webp)$/i.test(name)) continue;
    out.push({
      node: node(name),
      rel: `${prefix}${name}`,
      name,
      bytes: Number(st.size),
      mtime: st.mtimeMs / 1000,
    });
  }
}

/** UI-72, LOOP-39, LOOP-42: every file of an intent's runs, with the stage it belongs to. */
function findRunFiles(home: Home, id: string): FoundFile[] {
  if (!RUN_NAME.test(id) || id === "." || id === "..") return [];
  const dir = join(home.root, "runs", id);
  const out: FoundFile[] = [];
  let top: string[];
  try {
    top = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of top) {
    const def = NODE_OF_FOLDER.get(name);
    if (def) scanDir(join(dir, name), `${name}/`, () => def.id, out);
  }
  // Flat files of runs written before the stage folders.
  scanDir(dir, "", flatStage, out);
  return out;
}

const SKIP_WHY = /^no (behaviour change|proof needed|local checks|CI on this repo)/i;

/** The plain words of a step back (UI-74): "checks failed: 2 tests red". */
function returnWords(t: Pick<Transition, "event" | "why">, from: StageId): string {
  const what =
    t.event === "red"
      ? from === "verify"
        ? "checks failed"
        : from === "proof"
          ? "the new tests did not prove the change"
          : from === "ci"
            ? "CI failed"
            : from === "review"
              ? "the review asked for changes"
              : from === "deploy"
                ? "the deploy failed"
                : `${NODE_BY_ID.get(from)?.name.toLowerCase() ?? from} failed`
      : t.event === "feedback"
        ? from === "review"
          ? "the review asked for changes"
          : "you asked for changes"
        : t.event === "answered"
          ? "you answered"
          : t.event === "conflict"
            ? "the PR conflicted with its base branch"
            : t.event === "head_moved"
              ? "the PR changed"
              : from === "rollback"
                ? "fix round"
                : "sent back";
  const why = (t.why ?? "").split("\n")[0]!.trim();
  return why && why.length <= 80 && why.toLowerCase() !== what ? `${what}: ${why}` : what;
}

/** UI-72..75: one attempt's path through the pipeline, from its moves and the stage folders. */
export function stageMap(
  m: Pick<Mission, "attempt" | "created" | "stage">,
  ts: Pick<Transition, "at" | "from_stage" | "to_stage" | "event" | "why">[],
  files: FoundFile[],
  now: number,
): StageMapView {
  type Seg = { node: StageId; at: number; via: (typeof ts)[number] | null; end: boolean };
  const sorted = [...ts].sort((a, b) => a.at - b.at);
  const raw: { stage: Stage; at: number; via: (typeof ts)[number] | null }[] = [];
  if (sorted.length) raw.push({ stage: sorted[0]!.from_stage, at: m.created, via: null });
  for (const t of sorted) raw.push({ stage: t.to_stage, at: t.at, via: t });
  const segs: Seg[] = [];
  for (const r of raw) {
    const def = NODE_OF_STAGE.get(r.stage);
    if (!def) {
      // done, stopped and pick are not stages of the map: they only end the one before.
      segs.push({ node: "other", at: r.at, via: r.via, end: true });
      continue;
    }
    const prev = segs[segs.length - 1];
    if (prev && !prev.end && prev.node === def.id) continue;
    segs.push({ node: def.id, at: r.at, via: r.via, end: false });
  }
  const visits: VisitView[] = [];
  const rounds = new Map<StageId, number>();
  const live = !finished(m.stage);
  segs.forEach((s, i) => {
    if (s.end) return;
    const next = segs[i + 1];
    const lv = next?.via ?? null;
    const round = (rounds.get(s.node) ?? 0) + 1;
    rounds.set(s.node, round);
    const def = NODE_BY_ID.get(s.node)!;
    let outcome: VisitOutcome = "passed";
    const reason: string | null = lv?.why ?? null;
    let returnTo: StageId | null = null;
    if (!next) {
      outcome = !live ? "passed" : def.owner ? "waiting on you" : "working now";
    } else if (next.end) {
      outcome = lv?.to_stage === "done" ? "passed" : "sent back";
    } else if (lv?.event === "red") {
      outcome = "red";
      returnTo = next.node;
    } else if (s.node === "rollback" && lv?.event === "ok") {
      // UI-123: back on the last good version, so the rollback passed; the build that follows is a fix round.
      returnTo = next.node;
    } else if (lv?.event === "wait" && next.node === "answer") {
      outcome = def.owner ? "passed" : /red|fail/i.test(lv.why ?? "") ? "red" : "passed";
    } else if ((NODE_INDEX.get(next.node) ?? 0) < (NODE_INDEX.get(s.node) ?? 0)) {
      outcome = "sent back";
      returnTo = next.node;
    } else if (lv && SKIP_WHY.test(lv.why ?? "")) {
      outcome = "skipped";
    }
    // After an answer the work resumes where the question came from, not at the answer.
    if (s.node === "answer" && next && !next.end) returnTo = null;
    const end = next ? next.at : live ? null : s.at;
    visits.push({
      stage: s.node,
      round,
      start: s.at,
      end,
      time: duration(Math.max(0, (end ?? now) - s.at)),
      outcome,
      reason,
      returnTo,
      returnLabel: returnTo && lv ? returnWords(lv, s.node) : null,
      files: [],
    });
  });
  // Attach each file to a round: the one in its name, else the visit running when it was written.
  const shown: StageFileView[] = files.map((f) => {
    const { kind, details } = kindOf(f.name);
    // UI-123: the smoke suites a rollback runs write to the e2e folder, but belong to the rollback. They
    // run minutes after it starts; the red suite's own log is written in the same second it starts.
    const during = visits.filter((v) => v.start + 2 <= f.mtime).at(-1);
    const node: StageId = f.node === "e2e" && during?.stage === "rollback" ? "rollback" : f.node;
    const vs = visits.filter((v) => v.stage === node);
    const named = /-(\d+)/.exec(f.name)?.[1];
    let round: number | null = named ? Number(named) : null;
    if (vs.length && (round === null || round > vs.length || kind === "Details")) {
      const v = [...vs].reverse().find((x) => x.start <= f.mtime + 1) ?? vs[0]!;
      round = v.round;
    }
    return {
      stage: node,
      round,
      kind: f.images ? "Screenshots" : kind,
      name: f.name,
      path: f.images ? null : f.rel,
      size: f.images ? `${f.images} image${f.images === 1 ? "" : "s"}` : size(f.bytes),
      at: when(f.mtime, now),
      details,
    };
  });
  const furthest = Math.max(-1, ...visits.map((v) => NODE_INDEX.get(v.stage) ?? -1));
  const noSpec = visits.find((v) => v.stage === "design" && v.reason && SKIP_WHY.test(v.reason));
  const stages: StageNodeView[] = [];
  for (const def of NODES) {
    const vs = visits.filter((v) => v.stage === def.id);
    const own = shown.filter((f) => f.stage === def.id);
    for (const v of vs) v.files = own.filter((f) => f.round === v.round);
    if ((def.id === "answer" || def.ship) && vs.length === 0) continue;
    if (def.id === "other" && own.length === 0) continue;
    const last = vs[vs.length - 1];
    let outcome: VisitOutcome = last?.outcome ?? "not reached";
    let note: string | null = last?.outcome === "skipped" ? last.reason : null;
    if (!last && def.id !== "other" && (NODE_INDEX.get(def.id) ?? 0) < furthest) {
      outcome = "skipped";
      note =
        noSpec && ["spec_review", "plan", "plan_review"].includes(def.id)
          ? noSpec.reason
          : "not needed this time";
    }
    const secs = vs.reduce((a, v) => a + Math.max(0, (v.end ?? now) - v.start), 0);
    stages.push({
      id: def.id,
      name: def.name,
      owner: def.owner,
      outcome,
      time: vs.length ? duration(secs) : "",
      secs,
      note,
      current: !!last && last.end === null && live,
      visits: vs,
      files: own,
    });
  }
  const worked = visits.filter((v) => !NODE_BY_ID.get(v.stage)!.owner);
  const spent = (list: VisitView[]) => list.reduce((a, v) => a + Math.max(0, (v.end ?? now) - v.start), 0);
  const waiting = visits.filter((v) => NODE_BY_ID.get(v.stage)!.owner);
  const lastVisit = visits[visits.length - 1];
  const open =
    stages.find((s) => s.current && s.owner)?.id ??
    [...visits].reverse().find((v) => v.outcome === "red")?.stage ??
    stages.find((s) => s.current)?.id ??
    lastVisit?.stage ??
    null;
  return {
    attempt: m.attempt,
    visits,
    stages,
    open,
    towercab: duration(spent(worked)),
    owner: duration(spent(waiting)),
  };
}

function sentenceOf(
  st: StateView,
  m: Mission | null,
  inStep: string,
  i: Intent | null,
  reason: string | null,
  now: number,
): string {
  switch (st.key) {
    case "needs":
      return m ? `${stepWords(m.stage)} for ${inStep}.` : "Waiting for you.";
    case "working":
      return `${stepWords(m!.stage)} for ${inStep}.`;
    case "ci":
      return `Waiting for CI for ${inStep}.`;
    case "cooling":
      return `${modelName(m!.limit_model ?? m!.model)} hit its usage limit; it goes on ${st.note ?? "after the reset"}.`;
    case "stalled":
      return `Stuck at ${stepWords(m!.stage).toLowerCase()}: no move ${st.note}.`;
    case "paused":
      return m ? `Paused ${st.note}; it goes on when you resume.` : (reason ?? "Paused.");
    case "done": {
      const at = m?.finished ?? null;
      return `Done${at ? ` ${ago(at, now)}` : ""}${i?.cost !== null && i?.cost !== undefined ? `; it cost ${money(i.cost)}` : ""}.`;
    }
    case "unverified":
      // UI-162: merged, but the repo can't check the change live.
      return `Merged, not verified live${m?.finished ? ` ${ago(m.finished, now)}` : ""}. No live check set up for this repo.`;
    case "dropped":
      return `Dropped${m?.finished ? ` ${ago(m.finished, now)}` : ""}.`;
    case "parked":
      return "Parked: below the cutoff. Raise its urgency or importance to run it.";
    case "upnext":
      return "Starts as soon as a slot is free.";
    default:
      return reason ?? "Waiting to start.";
  }
}

/** The intent page's data (`GET /api/intents/<id>`); null when there is no such intent. */
export async function intentPage(src: UiSources, id: string): Promise<IntentPage | null> {
  const s = await snapshot(src);
  let intent: Intent | null = s.intents.get(id) ?? null;
  if (!intent) {
    try {
      intent = await src.store.get(id);
    } catch {
      intent = null;
    }
  }
  const realId = intent?.id ?? id;
  const missions = forIntent(src.db, realId);
  if (!intent && missions.length === 0) return null;
  const ids = missions.map((m) => m.id);
  const ts = ids.length
    ? src.db.all<Transition>(
        `SELECT * FROM transitions WHERE mission IN (${ids.map(() => "?").join(",")}) ORDER BY at, id`,
        ...ids,
      )
    : [];
  const live = missions.find((m) => !finished(m.stage)) ?? null;
  const last = live ?? missions[missions.length - 1] ?? null;
  const lastMove = (m: Mission) => ts.filter((t) => t.mission === m.id).pop()?.at ?? m.created;
  const entry = src.upNext().find((u) => u.intent === realId) ?? null;
  const canStart =
    src.running &&
    !live &&
    !!intent &&
    !intent.done &&
    !intent.waiting &&
    entry?.skip?.kind !== "parked" &&
    entry !== null;
  const titles = (x: string) => titleOf(s, x);
  let st: StateView;
  let reason: string | null = null;
  if (live) {
    st = stateOf(live, s.now, {
      enteredAt: lastMove(live),
      cooldownUntil: live.limit_model ? (s.cooldowns.get(live.limit_model) ?? null) : null,
      config: src.config,
    });
  } else if (intent?.done) {
    st =
      s.listing?.droppedIds.has(realId) || intent.stage === "dropped"
        ? state("dropped")
        : finishedState(intent);
  } else if (intent?.waiting) {
    st = state("needs", "Blocked");
  } else if (waitingFor(s, intent)) {
    // LOOP-75: `after` waits for the other intent to be done, and says where it is now.
    st = state("queued");
    reason = waitingFor(s, intent);
  } else if (entry) {
    st = skipState(entry.skip, false);
    reason = skipWords(entry.skip, titles, s.now);
  } else if (intent && priority(intent.u, intent.i) < src.config.intents.cutoff) {
    st = state("parked");
  } else if (last) {
    st = stateOf(last, s.now);
  } else {
    st = state("queued");
  }
  const card =
    live && isWait(live.stage) && !isReady(live)
      ? missionCard(src, live, intent ?? undefined, lastMove(live), s.now)
      : !live && intent?.waiting && !intent.done
        ? intentCard(intent, src.config)
        : null;
  const timeline: TimelineItem[] = [];
  for (const m of missions) {
    timeline.push({
      at: when(m.created, s.now),
      text:
        m.attempt > 1
          ? `Attempt ${m.attempt} started (${modelName(m.model)})`
          : `Picked up (${modelName(m.model)})`,
      why: null,
      lasted: null,
      tone: "move",
    });
    const mts = ts.filter((t) => t.mission === m.id);
    mts.forEach((t, n) => {
      const next = mts[n + 1];
      const kind = moveKind(t);
      timeline.push({
        at: when(t.at, s.now),
        text: moveWords(t),
        why: t.to_stage === "stopped" ? null : t.why,
        lasted: next ? duration(next.at - t.at) : null,
        tone: t.to_stage === "done" ? "done" : kind === "log" ? "move" : kind,
      });
    });
  }
  const found = findRunFiles(src.home, realId);
  const attempts: AttemptView[] = missions.map((m, n) => {
    const nextCreated = missions[n + 1]?.created ?? Infinity;
    // Files of one attempt: written from its start until the next attempt began.
    const mine =
      missions.length > 1 ? found.filter((f) => f.mtime >= m.created - 5 && f.mtime < nextCreated) : found;
    return {
      attempt: m.attempt,
      state: stateOf(m, s.now, { enteredAt: lastMove(m), config: src.config }),
      cost: money(m.cost_usd),
      agentTime: duration(m.agent_secs),
      started: when(m.created, s.now),
      map: stageMap(
        m,
        ts.filter((t) => t.mission === m.id),
        mine,
        s.now,
      ),
    };
  });
  const sections: { title: string; text: string }[] = [];
  for (const [title, text] of intent?.sections ?? []) {
    if (title !== "Answers" && text.trim()) sections.push({ title, text });
  }
  const scores = intent
    ? `Priority ${priority(intent.u, intent.i)} · urgency ${intent.u ?? 3}, importance ${intent.i ?? 3}${intent.a !== null ? `, autonomy ${intent.a}` : ""}`
    : "";
  const body: Omit<IntentPage, "version"> = {
    id: realId,
    title: intent?.title ?? realId,
    repo: intent?.repo ?? last?.repo ?? "",
    scores,
    canStart,
    state: st,
    sentence: sentenceOf(
      st,
      live ?? last,
      live ? duration(s.now - lastMove(live)) : "",
      intent,
      reason,
      s.now,
    ),
    prs: prViews(src, intent, last, ts),
    card,
    timeline,
    attempts,
    sections,
    answers: intent?.sections.get("Answers")?.trim() || null,
    file: intent ? src.intentUrl(intent) : null,
    issue: intent?.issue ?? null,
    e2eLog: e2eLogOf(src.home.root, id),
  };
  // UI-160, UI-162: the owner's steps, and the plan's claim that nothing could be checked live.
  const shown = live ?? last;
  const sd = shown ? dataOf<{ steps?: OwnerStep[]; liveNoneWhy?: string }>(shown) : {};
  if (sd.steps?.length) {
    body.steps = [...sd.steps]
      .sort((a, b) => (a.when === b.when ? a.n - b.n : a.when === "before" ? -1 : 1))
      .map((x) => {
        const at = x.done_at ? Date.parse(x.done_at) / 1000 : Number.NaN;
        return {
          n: x.n,
          when: x.when,
          text: x.text,
          why: x.why,
          doneAt: x.done_at ? when(Number.isFinite(at) ? at : (shown?.updated ?? s.now), s.now) : null,
        };
      });
    body.stepsWait =
      shown?.waiting === "your steps first" ? "before" : shown?.waiting === "your steps" ? "after" : null;
  }
  if (sd.liveNoneWhy?.trim() && intent?.done && intent.verified !== "no")
    body.nothingLive = sd.liveNoneWhy.trim();
  // SHIP-32: whether the release that contains the merge exists yet.
  const rel = last ? releaseLine(src.db, last) : null;
  if (rel) body.release = rel;
  // AUT-20: the latest risk, when no card already shows it.
  const risk = !card && last ? riskView(last) : null;
  if (risk) body.risk = risk;
  const tests = last ? existingTestsOf(last) : [];
  if (tests.length) body.tests = tests;
  // UI-127: the latest plain brief (code, else plan, else spec), when no card already leads with one.
  if (!card && last) {
    for (const kind of ["code", "plan", "spec"] as const) {
      const t = textsOf(last, kind);
      if (!t.brief) continue;
      body.brief = t.brief;
      body.details = t.details;
      break;
    }
  }
  return { version: versionOf(body, dbMark(src.db)), ...body };
}

/** UI-122: the newest e2e log of an intent, by modification time, as its run-file URL. */
export function e2eLogOf(root: string, id: string): string | null {
  const dir = join(root, "runs", id, "e2e");
  let best: { name: string; at: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".log")) continue;
      const at = lstatSync(join(dir, name)).mtimeMs;
      if (!best || at >= best.at) best = { name, at };
    }
  } catch {
    return null;
  }
  return best ? `/api/runs/${encodeURIComponent(id)}/e2e/${encodeURIComponent(best.name)}` : null;
}

/** UI-63: a queued intent is up next unless something other than its turn holds it. */
const HELD = new Set(["after", "cooling", "unreachable", "other"]);

/** The queue's data (`GET /api/queue`, UI-63): one lane per repo. */
export async function queue(src: UiSources): Promise<QueuePage> {
  const s = await snapshot(src);
  const lanes = lanesOf(src, s);
  return { version: versionOf(lanes, dbMark(src.db)), lanes };
}

/** UI-63: one lane per `[repos]` repo, then any other repo a mission names. */
export function lanesOf(src: UiSources, s: Snap): Lane[] {
  const list = src.upNext();
  const titles = (x: string) => titleOf(s, x);
  const repos = [...src.config.repos.keys()];
  for (const m of s.missions) if (!repos.includes(m.repo)) repos.push(m.repo);
  return repos.map((repo): Lane => {
    // The build slot's holder first, then plan-approved intents in build order, then those ahead.
    const rank = (m: Mission) => (isReady(m) ? 1 : isAhead(m) ? 2 : 0);
    const running = s.missions
      .filter((m) => m.repo === repo)
      .sort((a, b) => rank(a) - rank(b) || a.id - b.id)
      .map((m) => missionRow(src, s, m));
    const limit = src.config.repos.get(repo)?.ahead ?? 3;
    const aheadN = aheadIn(s.missions, repo).length;
    const mine = list.filter(
      (u) => s.intents.get(u.intent)?.repo === repo && !running.some((r) => r.intent === u.intent),
    );
    const item = (u: UpNext, position: number | null): QueueItem => ({
      intent: u.intent,
      title: titles(u.intent),
      position,
      state: skipState(u.skip, false),
      reason: skipWords(u.skip, titles, s.now),
      when: null,
      cost: null,
    });
    const queued = mine.filter((u) => u.skip?.kind !== "parked");
    const upNext = queued.filter((u) => !HELD.has(u.skip?.kind ?? "")).map((u, n) => item(u, n + 1));
    const waiting = queued.filter((u) => HELD.has(u.skip?.kind ?? "")).map((u) => item(u, null));
    const parked = mine.filter((u) => u.skip?.kind === "parked").map((u) => item(u, null));
    const dropped = s.listing?.droppedIds ?? new Set<string>();
    const done: QueueItem[] = (s.listing?.done ?? [])
      .filter((i) => i.repo === repo)
      .slice(0, 10)
      .map((i) => {
        const at = i.finished ? Date.parse(i.finished) / 1000 : Number.NaN;
        return {
          intent: i.id,
          title: i.title,
          position: null,
          state: dropped.has(i.id) || i.stage === "dropped" ? state("dropped") : finishedState(i),
          reason: null,
          when: Number.isFinite(at) ? when(at, s.now) : null,
          cost: i.cost !== null ? money(i.cost) : null,
        };
      });
    return {
      repo,
      github: src.config.repos.get(repo)?.github ?? "",
      ahead: `${aheadN} of ${limit} ahead`,
      running,
      upNext,
      waiting,
      parked,
      done,
    };
  });
}

export interface ActivityFilters {
  intent?: string;
  repo?: string;
  /** `moves`, `waits` or `errors`. */
  kind?: string;
  /** `1h`, `24h`, `7d`, `30d`, or unix seconds. */
  since?: string;
  offset?: number;
  limit?: number;
}

const KIND_FILTER: Record<string, ActivityKind> = { moves: "move", waits: "wait", errors: "error" };

export function sinceOf(since: string | undefined, now: number): number | null {
  if (!since) return null;
  const m = /^(\d+)([hd])$/.exec(since);
  if (m) return now - Number(m[1]) * (m[2] === "h" ? 3600 : DAY);
  const n = Number(since);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function logLines(src: UiSources): LogLine[] {
  if (src.logs) return src.logs();
  let text: string;
  try {
    text = readFileSync(src.home.logFile, "utf8");
  } catch {
    return [];
  }
  const out: LogLine[] = [];
  for (const block of text.split(/^--- /m).slice(1)) {
    const nl = block.indexOf("\n");
    const at = Date.parse(block.slice(0, nl).trim()) / 1000;
    const first =
      block
        .slice(nl + 1)
        .split("\n")
        .find((l) => l.trim()) ?? "";
    if (Number.isFinite(at) && first) out.push({ at, text: first.trim() });
  }
  return out;
}

const MOVE_LOG = /^\S+ \S+ → \S+ \(/;
const ERROR_LOG = /error|fail|panic|unexpected|refused|timed out|unreachable|can't|cannot/i;
const ID_IN_LOG = /\b(\d{6}-\d{4}-\d+)\b/;

/** The activity page's data (`GET /api/activity?intent=&repo=&kind=&since=`), newest first. */
export async function activity(src: UiSources, f: ActivityFilters = {}): Promise<ActivityPage> {
  const s = await snapshot(src);
  const since = sinceOf(f.since, s.now);
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const want = f.kind ? (KIND_FILTER[f.kind] ?? null) : null;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.intent) {
    where.push("m.intent = ?");
    params.push(f.intent);
  }
  if (f.repo) {
    where.push("m.repo = ?");
    params.push(f.repo);
  }
  if (since !== null) {
    where.push("t.at >= ?");
    params.push(since);
  }
  const rows = src.db.all<Transition & { intent: string; repo: string }>(
    `SELECT t.*, m.intent AS intent, m.repo AS repo FROM transitions t JOIN missions m ON m.id = t.mission
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.at DESC, t.id DESC LIMIT 5000`,
    ...params,
  );
  const items: ActivityItem[] = rows.map((t) => ({
    key: `t${t.id}`,
    at: when(t.at, s.now),
    time: clock(t.at),
    day: dayWords(t.at, s.now),
    kind: moveKind(t),
    intent: t.intent,
    title: titleOf(s, t.intent),
    repo: t.repo,
    text: moveWords(t),
    detail: t.to_stage === "stopped" ? null : t.why,
  }));
  const intentRepo = (id: string) => s.intents.get(id)?.repo ?? null;
  logLines(src).forEach((l, n) => {
    if (MOVE_LOG.test(l.text)) return;
    const id = ID_IN_LOG.exec(l.text)?.[1] ?? null;
    if (f.intent && id !== f.intent) return;
    if (f.repo && (!id || intentRepo(id) !== f.repo)) return;
    if (since !== null && l.at < since) return;
    items.push({
      key: `l${n}:${l.at}`,
      at: when(l.at, s.now),
      time: clock(l.at),
      day: dayWords(l.at, s.now),
      kind: ERROR_LOG.test(l.text) ? "error" : "log",
      intent: id,
      title: id ? titleOf(s, id) : null,
      repo: id ? intentRepo(id) : null,
      text: id ? l.text.replace(id, "").replace(/^[\s:·-]+/, "") : l.text,
      detail: null,
    });
  });
  const kept = items.filter((x) => !want || x.kind === want).sort((a, b) => b.at.at - a.at.at);
  const intents = new Map<string, string>();
  for (const r of src.db.all<{ intent: string }>("SELECT DISTINCT intent FROM missions ORDER BY id DESC")) {
    intents.set(r.intent, titleOf(s, r.intent));
  }
  const page = kept.slice(offset, offset + limit);
  const body = {
    items: page,
    more: kept.length > offset + limit,
    intents: [...intents].map(([id, title]) => ({ id, title })),
    repos: [...src.config.repos.keys()],
  };
  return { version: versionOf(body), ...body };
}

/** `Today`, `Yesterday`, `Mon 19 Oct`. */
export function dayWords(at: number, now: number): string {
  const days = dayOffset(at, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(at * 1000);
  return `${WEEKDAYS[d.getDay()]} ${dateWords(at, now)}`;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(bot)?\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Text with tokens, bot tokens, bearer headers and private keys taken out (UI-4). */
export function redact(text: string, config?: Config): string {
  let out = text;
  const bot = config?.telegram?.botToken;
  if (bot && bot.length >= 6) out = out.split(bot).join("<token>");
  for (const re of SECRET_PATTERNS)
    out = out.replace(re, (m) => (m.startsWith("-----") ? "<private key>" : "<token>"));
  return out;
}
