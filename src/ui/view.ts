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

/** UI-58: one wait on the owner. */
export interface Card {
  intent: string;
  title: string;
  repo: string;
  kind: CardKind;
  /** "Plan review", "Question", "Blocked". */
  kindLabel: string;
  ask: string;
  since: When | null;
  /** Markdown: the review summary, the gate's reason, Towercab's note. */
  brief: string | null;
  /** The reason Towercab gave, one paragraph. */
  why: string | null;
  question: Question | null;
  access: Access | null;
  pr: PrLink | null;
  actions: ActionKey[];
  mergeLabel: string | null;
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
}

export interface AirspaceView {
  planes: Plane[];
  landed: {
    count: number;
    cost: string;
    agentTime: string;
    /** Newest first. */
    recent: { intent: string; title: string; repo: string }[];
  };
  counts: { parked: number; queued: number; flying: number; needs: number; landed: number };
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
  label: "Spec" | "Plan" | "Code";
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

export interface StepTimeView {
  step: string;
  time: string;
  secs: number;
  owner: boolean;
}

export interface AttemptView {
  attempt: number;
  state: StateView;
  cost: string;
  agentTime: string;
  started: When;
}

export interface RunFileView {
  name: string;
  label: string;
  size: string;
  url: string;
}

export interface RunGroupView {
  step: string;
  files: RunFileView[];
}

export interface IntentPage {
  version: string;
  id: string;
  title: string;
  repo: string;
  /** "Priority 11 · urgency 3, importance 4". */
  scores: string;
  state: StateView;
  sentence: string;
  prs: PrView[];
  card: Card | null;
  timeline: TimelineItem[];
  times: { steps: StepTimeView[]; towercab: string; owner: string };
  attempts: AttemptView[];
  sections: { title: string; text: string }[];
  answers: string | null;
  runs: RunGroupView[];
  file: string | null;
  /** The GitHub issue the intent came from (INT-29), or null. */
  issue: string | null;
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
  running: Row[];
  waiting: QueueItem[];
  parked: QueueItem[];
  done: QueueItem[];
}

export interface QueuePage {
  version: string;
  lanes: Lane[];
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
