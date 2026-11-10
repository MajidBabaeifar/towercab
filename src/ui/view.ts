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
  | "unverified"
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
  | "Merged, not verified live"
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
  /** UI-244: of `needs`, the proposed intents; the rest are missions and intents waiting (`needs - proposed`). */
  proposed: number;
  working: number;
  queued: number;
  /** "2 need you · 1 working · 3 queued". */
  countsText: string;
  /** "2 of 4 runs going · the longest wait for a free slot is 12 min" (LOOP-104). */
  slotsText: string;
  spendToday: string;
  /** "of $20.00" when a daily budget is set. */
  budget: string | null;
  overBudget: boolean;
  /** UI-256: spend against the budgets; `note` is the words that go with amber or red. */
  budgetChip?: { text: string; level: "ok" | "amber" | "red"; note: string | null };
  version: { commit: string; behind: string | null };
  paused: boolean;
  /** No actions: the CLI serves the page without a loop (UI-2). */
  readOnly: boolean;
  /** A banner across the page, e.g. "Towercab isn't running". */
  banner: string | null;
}

export type ActionKey = "merge" | "pass" | "reply" | "retry" | "drop";
export type CardKind = "spec" | "plan" | "code" | "question" | "blocked" | "release" | "autonomy";

/** UI-257: the one control for an intent's autonomy. */
export interface AutonomyView {
  /** The level the intent runs at now (a flagged raise doesn't count yet). */
  a: number;
  /** The repo's cap when it is below a5 (AUT-8). */
  cap: number | null;
  /** AUT-35, UI-258: a raise somebody else made, waiting for the owner. */
  flag?: { who: string; from: number; to: number };
  /** What each level lets Towercab do without asking, for the confirm step (index = level). */
  notes: string[];
  /** The page is read-only, or the intent is finished. */
  locked: boolean;
  /** UI-206: the highest level offered: 5 for the owner's own intents, 4 for any other source. */
  max: number;
}

/** UI-203, UI-205, UI-207, UI-208: the score controls, Boost, and what a card says about autonomy. */
export interface ControlsView {
  u: number;
  i: number;
  priority: number;
  parked: boolean;
  /** UI-205: the Boost button is offered. */
  canBoost: boolean;
  /** UI-205: what the Boost confirm says it allows (and that it starts the intent now). */
  boostNote: string;
  /** UI-207: why a plane at a5 waits for the owner; null when it doesn't. */
  waitWhy: string | null;
  /** UI-208: `Lowered to a<n> by the worker: <why>`; null when nothing was lowered. */
  lowered: string | null;
}

export interface Question {
  context: string;
  question: string;
  /** `do`: what Towercab does when the owner picks it (PIP-114); absent in questions stored before. */
  options: { option: string; then: string; do?: "continue" | "steps" | "drop" }[];
  recommendation: string;
}

/** UI-164: one way out of a wait, as a button. */
export interface ExitView {
  do: string;
  label: string;
}

export interface Access {
  domains: { domain: string; why: string }[];
  paths: { glob: string; why: string }[];
  /** PIP-115: existing tests the plan asks to change. */
  tests?: { path: string; why: string }[];
}

/** PIP-118: an existing test the worker may change (or was refused), and who decided. */
export interface ExistingTestView {
  path: string;
  why: string;
  by: "plan" | "owner" | "refused";
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
  /** UI-248: the three in one line: "Medium risk · easy to undo · fairly sure it works". */
  line: string;
  summary: string;
  /** Why the floor raised the level (AUT-17), or null. */
  raised: string | null;
}

/** UI-58: one wait on the owner. */
export interface Card {
  /** UI-211: set when the reason is that the App isn't installed. */
  installHelp?: InstallHelpView;
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
  /** UI-164: every way out of this wait, in plain words; none once the owner has acted. */
  exits: ExitView[];
  /** LOOP-77: the wait came back with nothing new; a reply would land on it again. */
  stuck: boolean;
  mergeLabel: string | null;
  /** UI-105: the owner already acted from the page and the mission has not moved on; no buttons then. */
  done: { action: "merge" | "drop" | "retry" | "done" | "steps"; text: string; stuck: boolean } | null;
  /** UI-131: the intent's repo is unknown: its short name and a guess at `owner/name` ("" = none). */
  addRepo: { name: string; github: string } | null;
  /** AUT-20: the risk of what it waits on; null when none was judged (or the check didn't finish). */
  risk?: RiskView | null;
  /** UI-245: the owner's steps, when the wait is on them (the checklist of UI-160). */
  steps?: StepView[];
  /** PIP-97: the spec's open points for the owner (spec cards only). */
  openPoints?: { point: string; why: string }[];
  /** PIP-147: the host asks for approvals the reviewers can't give (UI-168). */
  warning?: string;
  /** UI-236: the intent is a draft of the shadow's (`source: shadow`). */
  shadow?: boolean;
  /** UI-243: the intent was proposed by the observer (`source: observer`). */
  observer?: boolean;
  /** UI-239: the intent is a0: only the owner can answer or approve it, shown as "only you". */
  onlyYou?: boolean;
  /** UI-257: the autonomy control. */
  autonomy?: AutonomyView;
  /** PIP-186: an agent answered for the owner and the intent acted on it: the agent's name. */
  decided_by_agent?: string | null;
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
  /** PIP-147: the host asks for approvals the reviewers can't give (UI-168). */
  warning?: string;
  /** UI-236: the intent is a draft of the shadow's. */
  shadow?: boolean;
  /** UI-243: the intent was proposed by the observer. */
  observer?: boolean;
  /** UI-257: the autonomy control. */
  autonomy?: AutonomyView;
  estimate?: EstimateLine;
}

/** UI-255: what an intent is expected to cost, or what it has spent against that. */
export interface EstimateLine {
  text: string;
  /** Spent so far as a share of the estimate, 0–100; null before it starts. */
  pct: number | null;
  /** Spent is above the usual range (the bar turns amber). */
  over: boolean;
}

/** UI-253: a scope's budget amounts (`all`, or a repo) and what is spent so far. */
export interface BudgetsView {
  scope: string;
  daily: number | null;
  monthly: number | null;
  spentDay: string;
  spentMonth: string;
  spentDayUsd: number;
  spentMonthUsd: number;
  where: string;
}

/** UI-254: a reached cap, as a Needs you card. */
export interface CapCard {
  key: string;
  scope: string;
  period: "day" | "month";
  title: string;
  line: string;
  reason: string;
  capUsd: number;
  spentUsd: number;
  raiseTo: number;
  /** Intents that would start but wait behind it. */
  waiting: number;
}

/** UI-211: how to install the GitHub App on a repo it can't reach (LOOP-122), folded under "See more". */
export interface InstallHelpView {
  app: string | null;
  url: string;
  steps: string[];
}

export interface ProblemView {
  /** UI-211: set when the reason is that the App isn't installed. */
  installHelp?: InstallHelpView;
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
  estimate?: EstimateLine;
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
  /** UI-253: the overall budget; present on the overview (`GET /api/state`). */
  budgets?: BudgetsView;
  /** UI-254: a card for each reached budget or cap, among the Needs you cards. */
  caps?: CapCard[];
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
  /** UI-205, UI-207, UI-208: Boost, the wait reason and the lowering note. */
  controls?: ControlsView;
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
  /** UI-184: every proposed intent, after the needs-you cards; absent when Towercab isn't reading them. */
  proposed?: ProposedSection;
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
  /** UI-236: the shadow did this. */
  shadow?: boolean;
  /** UI-243: the observer did this. */
  observer?: boolean;
}

/** UI-242: `GET /api/observer`. */
export interface ObserverView {
  enabled: boolean;
  /** The last run, or null before the first. */
  lastRun: {
    at: When;
    trigger: string;
    outcome: string;
    proposals: number;
    comments: number;
    why: string | null;
  } | null;
  proposalsThisWeek: number;
  maxPerWeek: number;
  spentToday: string;
  cap: string;
  spentUsd: number;
  capUsd: number;
  /** The daily cap is reached: no further run today. */
  capReached: boolean;
  /** When the last weekly report went out: a day `YYYY-MM-DD`, or null. */
  lastReport: string | null;
}

/** UI-237: one thing the shadow did, asked or refused. */
export interface ShadowActionView {
  id: number;
  at: When;
  /** A sentence, without the tag. */
  text: string;
  outcome: "done" | "refused" | "held";
  intent: string | null;
  pr: { number: number; url: string } | null;
}

/** UI-237: `GET /api/shadow`. */
export interface ShadowView {
  enabled: boolean;
  actions: ShadowActionView[];
  /** Asked, waiting for the owner's yes in Telegram. */
  pending: { action: string; intent: string }[];
  spentToday: string;
  cap: string;
  spentUsd: number;
  capUsd: number;
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
  | "steps"
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

/** PIP-186: a comment an agent wrote under the owner's login. */
export interface AgentCommentView {
  agent: string;
  url: string;
  at: When;
  excerpt: string;
  /** False when the intent ignored it (a0). */
  acted_on: boolean;
}

export interface IntentPage {
  version: string;
  id: string;
  title: string;
  repo: string;
  /** "Priority 11 · urgency 3, importance 4". */
  scores: string;
  /** UI-236: a draft of the shadow's (`source: shadow`). */
  shadow?: boolean;
  /** UI-243: proposed by the observer (`source: observer`). */
  observer?: boolean;
  /** UI-243: its evidence links and expected gain, shown above the rest of the text. */
  observerNote?: { evidence: string; gain: string };
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
  /** PIP-118: the existing tests the worker was allowed to change, or refused, and why. */
  tests?: ExistingTestView[];
  /** UI-160: the owner's steps from the plan, before-merge ones first. */
  steps?: StepView[];
  /** UI-160: which steps the mission waits on now (`your steps first`: before; `your steps`: after). */
  stepsWait?: "before" | "after" | null;
  /** UI-162: why the plan said nothing could be checked live, for a change that shows as done. */
  nothingLive?: string | null;
  /** UI-239: set for an a0 intent, with the line to show; `paused` is this intent's own pause (SHD-22). */
  onlyYou?: string;
  /** UI-257: the autonomy control. */
  autonomy?: AutonomyView;
  /** UI-203: urgency and importance as controls, and the notes of UI-207 and UI-208. */
  controls?: ControlsView;
  paused?: boolean;
  /** PIP-186: the comments agents wrote under the owner's login, oldest first. */
  agent_comments: AgentCommentView[];
  /** PIP-186: the agent that answered for the owner, when the intent acted on it. */
  decided_by_agent?: string | null;
  /** SHIP-32: "Published in v1.2.0" with its link, or "Merged, waiting for a release"; absent when the repo has no releases. */
  release?: { text: string; url: string | null };
}

/** UI-160: one of the owner's steps, with when it was ticked. */
export interface StepView {
  n: number;
  when: "before" | "after";
  text: string;
  why: string;
  doneAt: When | null;
  /** SHIP-33: the secret this step stands for (never its value). */
  secret?: SecretView;
}

/** SHIP-34, SHIP-35: where a secret step is, for the page's field and approve button. */
export interface SecretView {
  key: string;
  file: string;
  source: "generate" | "supply";
  /** The pull request that adds it, once there is one. */
  pr: { number: number; url: string } | null;
  approved: boolean;
  /** The last failure, and whether Towercab gave up trying until the owner asks again. */
  error: string | null;
  stopped: boolean;
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
/** UI-155: a repo missing setup, or one whose setup could not be checked. Absent for a ready repo. */
export interface ReadinessBadge {
  /** "Not ready", "Not ready · new work paused" or "Could not check". */
  label: string;
  /** New work waits (LOOP-70). */
  blocks: boolean;
  missing: number;
  unknown: number;
  /** The missing items in words, for a tooltip. */
  detail: string;
  /** The accessible name, with the counts. */
  name: string;
}

/** UI-156: the "Set up this repo" section. */
export interface SetupView {
  kind: string | null;
  confirmed: boolean;
  blocks: boolean;
  items: { item: string; state: "missing" | "unknown" | "waived"; words: string }[];
  /** Whether new intents wait or only a warning shows. */
  sentence: string;
  /** Lines to add to `TOWERCAB.md`. */
  hint: string[];
  /** The repo's open setup intent (LOOP-71), if any. */
  intent: { id: string; title: string } | null;
  /** The open pull request that proposes a setup intent for the repo (LOOP-71, LOOP-92), if any. */
  proposal: { url: string; title: string } | null;
}

export interface RepoChip {
  readiness?: ReadinessBadge;
  repo: string;
  /** Open intents: in progress, up next, waiting and parked. */
  open: number;
  /** Of them, waiting on the owner, proposed intents included (UI-244). */
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

/** UI-184: a proposed intent, as the card shows it. */
export interface ProposedCard {
  /** The PR's number; the anchor is `proposed-<pr>`. */
  pr: number;
  title: string;
  /** The repo as the intent file writes it; "" when the file can't be read. */
  repo: string;
  u: number | null;
  i: number | null;
  a: number | null;
  /** The number it would get; null when the file can't be read. */
  priority: number | null;
  /** "priority 11" or "would be parked". */
  priorityText: string;
  parked: boolean;
  /** "from Towercab". */
  from: string;
  /** "waiting 3 d". */
  waiting: string;
  waitingSince: number;
  draft: boolean;
  prUrl: string;
  /** "Read the intent": the file at the PR's head. */
  textUrl: string | null;
  /** The head SHA the card was built from; Accept sends it back (INT-53). */
  head: string;
  /** Why the card can't be accepted from here, or why the file can't be read; null when it can. */
  problem: string | null;
  canAccept: boolean;
  /** Shown beside the disabled Accept. */
  acceptWhy: string | null;
  /** UI-243: proposed by the observer (`source: observer`). */
  observer?: boolean;
  /** UI-243: its evidence and expected gain, shown first. */
  observerNote?: { evidence: string; gain: string };
}

/** UI-184, UI-188: the proposed cards in priority order, and a notice when the list may be old. */
export interface ProposedSection {
  cards: ProposedCard[];
  stale: string | null;
}

/** REPO-30: the standard GitHub settings of a repo, as last checked. */
export interface SettingsView {
  /** `ok`, `gaps` or `unknown` (never checked). */
  state: "ok" | "gaps" | "unknown";
  /** The one line the page leads with. */
  summary: string;
  gaps: string[];
  /** Why the ruleset or the apply was held back, or why the last check could not run. */
  notes: string[];
  /** When it was checked, unix seconds; 0 when never. */
  at: number;
  /** REPO-38: what Apply would change; empty when the plan has no lines to show. */
  plan: { what: string; now?: string; after?: string }[];
  /** REPO-38: why there is no plan to show, or null. */
  planNote: string | null;
  /** REPO-39: an Apply is running for this repo now. */
  applying: boolean;
  /** REPO-39: the Apply button is offered (gaps, and Towercab runs). */
  canApply: boolean;
}

/** UI-194: what one finished phase did, in its plain brief. */
export interface FocusHistory {
  label: "Spec" | "Plan" | "Code";
  text: string;
}

/** UI-259: one row of the Inbox: a needs-you card, a reached cap or a proposed intent, with its context. */
export interface InboxItem {
  /** The intent's ID, `proposed-<PR number>` or `cap-<scope>-<period>`: what the URL and the page key it by. */
  key: string;
  kind: "card" | "cap" | "proposed";
  repo: string;
  title: string;
  /** "Plan review", "Proposed", "Budget". */
  kindLabel: string;
  /** When the wait began (unix s); null when unknown. */
  since: number | null;
  /** The first sentence of the intent's Problem; null when it has none. */
  overview: string | null;
  history: FocusHistory[];
  card: Card | null;
  proposed: ProposedCard | null;
  cap: CapCard | null;
  /** The PR the item is about, for `o` (UI-261). */
  pr: number | null;
  prUrl: string | null;
  /** The card's main action is a merge, so `m` applies (UI-261). */
  merge: boolean;
  /** UI-264: began after the owner's last visit, or a snooze ran out after it. */
  new: boolean;
  /** UI-264: the wake time (unix s) while snoozed. */
  snoozedUntil: number | null;
}

/** UI-259: `GET /api/inbox`. */
export interface InboxPage {
  version: string;
  items: InboxItem[];
  /** UI-244's count; snoozed items are in it. */
  needs: number;
  /** UI-264: the owner's last visit (unix s) as the server holds it; null before the first. */
  lastVisit: number | null;
  readOnly: boolean;
  /** UI-188's notice when the proposed list may be old. */
  stale: string | null;
}

/** UI-150 to UI-154: a repo's limits (`workers`, `ahead`) as its `TOWERCAB.md` holds them. */
export interface LimitsView {
  values: { workers: number; ahead: number };
  defaults: { workers: number; ahead: number };
  /** Set in the file (so "Back to default" applies). */
  inFile: { workers: boolean; ahead: boolean };
  /** UI-152: the open settings PR and what it changes (null: a key back to the default). */
  pending: { pr: number; url: string; changes: { workers?: number | null; ahead?: number | null } } | null;
  moved: boolean;
  /** UI-150: variable names kept on this machine; never the values. */
  envNames: string[];
  /** UI-154: hours before Towercab moves the limits on its own; null once the wait is over. */
  waitHours: number | null;
  /** UI-153: `TOWERCAB.md in <repo> can't be read: <reason>`, or null. */
  fileError: string | null;
  fileUrl: string | null;
  move: {
    state: "waiting" | "open" | "closed" | "moved";
    pr: number | null;
    url: string | null;
    /** "Open the move PR again" works. */
    canOpen: boolean;
  };
  canSave: boolean;
}

/** UI-141: one repo's page. */
export interface RepoView {
  /** UI-150: the limits form. */
  limits: LimitsView;
  /** UI-253: this repo's daily and monthly caps. */
  budgets?: BudgetsView;
  settings: SettingsView;
  /** UI-156: what the repo is missing; absent when nothing is. */
  setup?: SetupView;
  /** UI-168: the repo needs a teammate's review: who may give it, and a warning when the host wants more. */
  teammate?: { reviewers: string[]; warning: string | null };
  repo: string;
  github: string;
  /** "1 of 3 ahead" (UI-100). */
  ahead: string;
  /** UI-186: the unmerged intent PRs for this repo. */
  proposed: ProposedSection;
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
  /** UI-153: the file's reason when `TOWERCAB.md` can't be read; absent otherwise. */
  fileError?: string;
  readiness?: ReadinessBadge;
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
  /** PIP-150: the one step for the code scanning alerts permission. */
  scanningStep: { text: string; canGrant: boolean } | null;
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
  /** UI-153: the file's reason when `TOWERCAB.md` can't be read; absent otherwise. */
  fileError?: string;
  readiness?: ReadinessBadge;
  /** "" for intents the listing doesn't know (the "unknown repo" lane). */
  repo: string;
  github: string;
  /** UI-147: intents waiting on the owner (cards with the Needs you chip). */
  waiting: number;
  /** UI-147: ISO time of the latest move of any of its intents; null when none. */
  changedAt: string | null;
  /** UI-147: its position in the board's row order (config order, "" last). */
  index: number;
  open: number;
  done: number;
  /** UI-187: proposed intents for this repo. */
  proposed: number;
  spend: RepoSpendView;
  /** Cards per column, in column order; columns without cards are absent. */
  cells: Partial<Record<BoardColumnKey, BoardCard[]>>;
}

export interface BoardPage {
  version: string;
  columns: BoardColumn[];
  repos: BoardRepo[];
  /** UI-187: how many proposed intents wait; absent when Towercab isn't reading them. */
  proposed?: number;
  /** UI-137: the totals over every repo. */
  spend: RepoSpendView;
  /** The intents repo can't be read: what went wrong, shown above the board. */
  error: string | null;
}

export type ActivityKind = "move" | "wait" | "error" | "log" | "settings";

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
  /** UI-204: after a score change, the new priority and whether the intent is parked. */
  priority?: number;
  parked?: boolean;
}
