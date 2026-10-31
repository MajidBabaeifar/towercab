// The JSON the page gets (UI-56 to UI-65): plain types shared by the server (src/ui/state.ts) and the
// browser (ui/src). No imports, so the browser bundle can use it.

/** UI-56's vocabulary. */
export type StateKey =
  | "needs"
  | "working"
  | "ci"
  | "queued"
  | "cooling"
  | "paused"
  | "stalled"
  | "upnext"
  | "parked"
  | "done"
  | "dropped";

export type StateLabel =
  | "Needs you"
  | "Working"
  | "Waiting on CI"
  | "Queued"
  | "Cooling down"
  | "Paused"
  | "Stalled"
  | "Up next"
  | "Parked"
  | "Done"
  | "Dropped";

export interface StateView {
  key: StateKey;
  label: StateLabel;
  /** A short qualifier: "until 14:05", "for 3 h 10 min", "Plan review". */
  note: string | null;
}

/** A time: relative words, the exact local time for hover, and the unix seconds. */
export interface When {
  at: number;
  rel: string;
  exact: string;
  /** A clock-style label: `14:05` today, `Mon 14:05` this week, `12 Oct` before. */
  short: string;
}

export type Health = "Running" | "Paused" | "Problem" | "Not running";

export interface TopBar {
  health: Health;
  /** One sentence under the health pill's hover. */
  healthNote: string;
  needs: number;
  working: number;
  queued: number;
  /** "2 need you · 1 working · 3 queued". */
  countsText: string;
  spendToday: string;
  /** "of $20.00" when a daily budget is set. */
  budget: string | null;
  overBudget: boolean;
  version: { commit: string; behind: string | null };
  paused: boolean;
  /** No actions: the CLI serves the page without a loop (UI-2). */
  readOnly: boolean;
  /** A banner across the page, e.g. "Towercab isn't running". */
  banner: string | null;
}

export type ActionKey = "merge" | "reply" | "retry" | "drop";
export type CardKind = "spec" | "plan" | "code" | "question" | "blocked";

export interface Question {
  context: string;
  question: string;
  options: { option: string; then: string }[];
  recommendation: string;
}

export interface Access {
  domains: { domain: string; why: string }[];
  paths: { glob: string; why: string }[];
}

export interface PrLink {
  number: number;
  url: string;
  label: string;
}

/** AUT-20: a change's risk in plain words. */
export interface RiskView {
  level: "low" | "medium" | "high";
  /** "Medium risk". */
  label: string;
  /** Which PR it was judged on: "spec", "plan" or "code". */
  gate: "spec" | "plan" | "code";
  /** Who it could affect, if it can be undone, how sure we are: one plain line each. */
  blast: string;
  door: string;
  certainty: string;
  summary: string;
  /** Why the floor raised the level (AUT-17), or null. */
  raised: string | null;
}

/** UI-58: one wait on the owner. */
export interface Card {
  intent: string;
  title: string;
  repo: string;
  kind: CardKind;
  /** "Plan review", "Question", "Blocked". */
  kindLabel: string;
  /** What the owner decides or does, in plain words (LOOP-14 **Waits**). */
  ask: string;
  since: When | null;
  /** UI-126: Markdown, the plain brief of what it waits on (no code words); Towercab's note as a fallback. */
  brief: string | null;
  /** The plain reason it waits for the owner, one paragraph; a blocked wait's technical reason is in `details`. */
  why: string | null;
  /** UI-126: Markdown, the technical text agents feed on (concerns, findings, logs), folded under "Details". */
  details: string | null;
  question: Question | null;
  access: Access | null;
  pr: PrLink | null;
  actions: ActionKey[];
  mergeLabel: string | null;
  /** UI-105: the owner already acted from the page and the mission has not moved on; no buttons then. */
  done: { action: "merge" | "drop" | "retry"; text: string; stuck: boolean } | null;
  /** UI-131: the intent's repo is unknown: its short name and a guess at `owner/name` ("" = none). */
  addRepo: { name: string; github: string } | null;
  /** AUT-20: the risk of what it waits on; null when none was judged (or the check didn't finish). */
  risk?: RiskView | null;
  /** PIP-97: the spec's open points for the owner (spec cards only). */
  openPoints?: { point: string; why: string }[];
}

export type PhaseStatus = "done" | "current" | "todo" | "skipped";

export interface Phase {
  label: "Spec" | "Plan" | "Code";
  status: PhaseStatus;
}

/** UI-59: a moving intent. */
export interface Row {
  intent: string;
  title: string;
  repo: string;
  state: StateView;
  phases: Phase[];
  step: string;
  inStep: string;
  cost: string;
  model: string;
  /** For a queued row: what it waits behind, in words. */
  behind: string | null;
}

export interface ProblemView {
  key: string;
  title: string;
  detail: string | null;
  fix: string;
  intent: string | null;
  tone: "warn" | "error";
  /** The detail is program output (a check's failure), shown as code. */
  code: boolean;
}

export interface UpNextView {
  intent: string;
  title: string;
  repo: string;
  priority: number;
  state: StateView;
  /** Why it doesn't start now, in words; null when it is next. */
  reason: string | null;
  /** The "Start now" button is offered (UI-101). */
  canStart: boolean;
}

export interface SpendDay {
  date: string;
  label: string;
  cost: number;
  text: string;
}

export interface SpendView {
  today: string;
  week: string;
  budget: string | null;
  todayUsd: number;
  budgetUsd: number | null;
  days: SpendDay[];
}

/** UI-78: the airspace's stations, in line order. */
export type StationKey =
  | "parked"
  | "queue"
  | "gate"
  | "spec"
  | "spec-review"
  | "plan"
  | "plan-review"
  | "code"
  | "ci"
  | "code-review"
  | "deploy"
  | "e2e"
  | "landed";

/** UI-78: one open intent on the airspace line. */
export interface Plane {
  intent: string;
  title: string;
  repo: string;
  state: StateView;
  station: StationKey;
  /** Two short lines for its card (UI-80). */
  lines: [string, string];
  phases: Phase[];
  /** The "Start now" button is offered (UI-101). */
  canStart: boolean;
  /** UI-125: rolling back, reverting, or in a fix round; absent otherwise. */
  ship?: { kind: "rollback" | "revert" | "fix"; mark: string };
  /** UI-110: why a plane waiting at merge is held ("Held until you resume"); absent otherwise. */
  held?: string;
}

/** UI-109: why the airspace is stopped. The owner's pause can be resumed; a service pause cannot. */
export type GroundStop =
  | { kind: "owner"; text: string; since: number | null; canResume: boolean }
  | { kind: "health"; text: string; service: string; reason: string };

export interface AirspaceView {
  /** UI-109: null while the loop is running. */
  stop: GroundStop | null;
  planes: Plane[];
  landed: {
    count: number;
    cost: string;
    agentTime: string;
    /** Newest first. */
    recent: { intent: string; title: string; repo: string }[];
  };
  counts: { parked: number; queued: number; flying: number; needs: number; landed: number };
  /** UI-120: a plane sits at a ship station, or a mission entered `deploy` in the last 7 days. */
  ship: boolean;
  /** "6 in flight · 3 need you · 1 landed today". */
  countsText: string;
  /** One sentence for screen readers. */
  summary: string;
}

export interface Overview {
  version: string;
  top: TopBar;
  needs: Card[];
  problems: ProblemView[];
  working: Row[];
  queued: Row[];
  upNext: UpNextView[];
  spend: SpendView;
  airspace: AirspaceView;
}

export type PrState = "open" | "merged" | "closed" | "not needed" | "not yet";

export interface PrView {
  /** UI-124: a shipping change also has "Fix 1", "Fix 2" and "Revert". */
  label: "Spec" | "Plan" | "Code" | `Fix ${number}` | "Revert";
  state: PrState;
  number: number | null;
  url: string | null;
}

export interface TimelineItem {
  at: When;
  text: string;
  why: string | null;
  /** How long it stayed after this move ("12 min"), null for the current one. */
  lasted: string | null;
  tone: "move" | "wait" | "error" | "done";
}

/** The stages of the map, in pipeline order (UI-72). `other` only holds files no stage claims (LOOP-42). */
export type StageId =
  | "design"
  | "spec_review"
  | "plan"
  | "plan_review"
  | "build"
  | "verify"
  | "proof"
  | "publish"
  | "ci"
  | "review"
  | "gate"
  | "merge"
  | "code_review"
  | "deploy"
  | "e2e"
  | "rollback"
  | "revert"
  | "answer"
  | "other";

export type VisitOutcome =
  | "passed"
  | "red"
  | "sent back"
  | "waiting on you"
  | "working now"
  | "skipped"
  | "not reached";

/** One time a mission was in a stage (UI-72). */
export interface VisitView {
  stage: StageId;
  /** 1 for the first time in this stage. */
  round: number;
  start: number;
  /** null while it runs. */
  end: number | null;
  time: string;
  outcome: VisitOutcome;
  /** Why it moved on, or why it was skipped. */
  reason: string | null;
  /** The stage it went back to, if it did. */
  returnTo: StageId | null;
  /** "checks failed: 2 tests red": the plain words of the step back. */
  returnLabel: string | null;
  files: StageFileView[];
}

export interface StageFileView {
  stage: StageId;
  round: number | null;
  /** "Prompt sent", "Claude's answer", "Check output", "Errors", "Screenshots", "Details", "File". */
  kind: string;
  /** The file name, shown small. */
  name: string;
  /** `<stage>/<file>` (or the flat `<file>`) for `GET /api/runs/<id>/…`; null when it can't be shown as text. */
  path: string | null;
  size: string;
  at: When;
  /** Claude settings, system prompt and guard file: folded under "Details". */
  details: boolean;
}

/** One node of the map (UI-73). */
export interface StageNodeView {
  id: StageId;
  name: string;
  /** A wait on the owner. */
  owner: boolean;
  outcome: VisitOutcome;
  /** Total time spent in it ("" when never reached). */
  time: string;
  secs: number;
  /** Why it was skipped. */
  note: string | null;
  current: boolean;
  /** Rounds, in order. */
  visits: VisitView[];
  /** Everything it wrote, newest last. */
  files: StageFileView[];
}

/** One attempt's path through the pipeline (UI-72..74). */
export interface StageMapView {
  attempt: number;
  /** Every visit, in order. */
  visits: VisitView[];
  /** Every stage in pipeline order, reached or not. */
  stages: StageNodeView[];
  /** The stage that matters most (UI-75): waiting on you, else last red, else current, else the last. */
  open: StageId | null;
  towercab: string;
  owner: string;
}

export interface AttemptView {
  attempt: number;
  state: StateView;
  cost: string;
  agentTime: string;
  started: When;
  /** The path this attempt took (UI-72). */
  map: StageMapView;
}

export interface IntentPage {
  version: string;
  id: string;
  title: string;
  repo: string;
  /** "Priority 11 · urgency 3, importance 4". */
  scores: string;
  /** The "Start now" button is offered (UI-101). */
  canStart: boolean;
  state: StateView;
  sentence: string;
  prs: PrView[];
  card: Card | null;
  timeline: TimelineItem[];
  attempts: AttemptView[];
  sections: { title: string; text: string }[];
  answers: string | null;
  file: string | null;
  /** The GitHub issue the intent came from (INT-29), or null. */
  issue: string | null;
  /** UI-122: the newest e2e log (`/api/runs/<id>/e2e/<file>`), or null. */
  e2eLog: string | null;
  /** AUT-20: the latest risk of the current attempt, when no card shows it. */
  risk?: RiskView | null;
  /** UI-127: the latest plain brief (what changes for users), when no card shows one. */
  brief?: string | null;
  /** UI-127: the latest technical text behind that brief, folded under "Details". */
  details?: string | null;
}

export interface QueueItem {
  intent: string;
  title: string;
  position: number | null;
  state: StateView;
  reason: string | null;
  when: When | null;
  cost: string | null;
}

export interface Lane {
  repo: string;
  github: string;
  /** "1 of 3 ahead": intents before build against `[repos.<r>].ahead` (UI-100). */
  ahead: string;
  running: Row[];
  /** Queued in pick order, numbered: nothing but their turn holds them (UI-63). */
  upNext: QueueItem[];
  /** Queued but held by something else (a dependency, a usage limit, a service), with the reason. */
  waiting: QueueItem[];
  parked: QueueItem[];
  done: QueueItem[];
}

export interface QueuePage {
  version: string;
  lanes: Lane[];
}

/** UI-140: one repo chip of the Repos tab. */
export interface RepoChip {
  repo: string;
  /** Open intents: in progress, up next, waiting and parked. */
  open: number;
  /** Of them, waiting on the owner. */
  needs: number;
}

/** UI-143: one line of a repo's feature list. */
export interface FeatureView {
  text: string;
  /** The intent the line is for, linked on the page; null for the owner's or the backfill's lines. */
  intent: string | null;
}

/** UI-143, UI-144: a repo's feature list, grouped, and where its backfill stands. */
export interface FeaturesView {
  inProgress: FeatureView[];
  live: FeatureView[];
  /** The file's planned lines, then queued intents that have no line (INT-40). */
  planned: FeatureView[];
  /** `features/<repo>.md` on GitHub, or null. */
  url: string | null;
  /** The backfill (INT-39): never asked, asked, running, done or failed. */
  run: "never" | "due" | "running" | "done" | "failed";
  /** One sentence on where the backfill stands; null when there is nothing to say. */
  note: string | null;
  /** "Refresh from the repo" is offered: Towercab runs and the repo is in the config. */
  canRefresh: boolean;
}

/** UI-141: one repo's page. */
export interface RepoView {
  repo: string;
  github: string;
  /** "1 of 3 ahead" (UI-100). */
  ahead: string;
  features: FeaturesView;
  inProgress: Row[];
  upNext: QueueItem[];
  waiting: QueueItem[];
  parked: QueueItem[];
  /** The last 10 done or dropped (UI-63), shown folded. */
  done: QueueItem[];
  spend: RepoSpendView;
}

/** UI-142: one repo on the All overview. */
export interface RepoSummary {
  repo: string;
  github: string;
  inProgress: number;
  needs: number;
  upNext: number;
  waiting: number;
  parked: number;
  spend: RepoSpendView;
}

/** `GET /api/repos[?repo=<name>]`. */
export interface ReposPage {
  version: string;
  chips: RepoChip[];
  /** The chosen repo, or null for All. */
  selected: string | null;
  /** The chosen repo's page; null on All. */
  repo: RepoView | null;
  /** All: one summary per repo; empty when a repo is chosen. */
  all: RepoSummary[];
  /** The totals over every repo (UI-137). */
  spend: RepoSpendView;
  /** What went wrong: the intents repo can't be read, or the asked-for repo doesn't exist. */
  error: string | null;
}

/** UI-137: what Towercab spent on one repo (or on all of them). */
export interface RepoSpendView {
  today: string;
  week: string;
  all: string;
  todayUsd: number;
  weekUsd: number;
  allUsd: number;
}

/** UI-133: the board's columns, the airspace stations from the queue on, then done. */
export type BoardColumnKey = Exclude<StationKey, "parked" | "landed"> | "done";

export interface BoardColumn {
  key: BoardColumnKey;
  label: string;
  /** Cards in this column over all repos; 0 draws it narrow (UI-136). */
  count: number;
}

export interface BoardCard {
  intent: string;
  title: string;
  state: StateView;
  /** UI-125: rolling back, reverting, or in a fix round; absent otherwise. */
  ship?: { kind: "rollback" | "revert" | "fix"; mark: string };
}

/** UI-133: one repo's row. */
export interface BoardRepo {
  /** "" for intents the listing doesn't know (the "unknown repo" lane). */
  repo: string;
  github: string;
  open: number;
  done: number;
  spend: RepoSpendView;
  /** Cards per column, in column order; columns without cards are absent. */
  cells: Partial<Record<BoardColumnKey, BoardCard[]>>;
}

export interface BoardPage {
  version: string;
  columns: BoardColumn[];
  repos: BoardRepo[];
  /** UI-137: the totals over every repo. */
  spend: RepoSpendView;
  /** The intents repo can't be read: what went wrong, shown above the board. */
  error: string | null;
}

export type ActivityKind = "move" | "wait" | "error" | "log";

export interface ActivityItem {
  key: string;
  at: When;
  /** `14:05`: items are grouped by `day`. */
  time: string;
  day: string;
  kind: ActivityKind;
  intent: string | null;
  title: string | null;
  repo: string | null;
  text: string;
  detail: string | null;
}

export interface ActivityPage {
  version: string;
  items: ActivityItem[];
  more: boolean;
  intents: { id: string; title: string }[];
  repos: string[];
}

export interface ActionReply {
  ok: boolean;
  message: string;
}
