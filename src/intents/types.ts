// The intent store's contract (INT-12). src/intents/store.ts implements it; tests use the real one
// over local bare repos.

/** A readable intent file (INT-2, INT-5). */
export interface Intent {
  id: string;
  slug: string;
  /** Folder relative to the intents repo root: `intents/<id>-<slug>` or `done/<id>-<slug>`. */
  dir: string;
  /** In `done/`. */
  done: boolean;
  title: string;
  repo: string;
  u: number | null;
  i: number | null;
  a: number | null;
  after: string[];
  model: string | null;
  review: string | null;
  source: string | null;
  /** The GitHub issue this intent came from (INT-23). */
  issue: string | null;
  started: string | null;
  unlock: string[];
  network: string[];
  // Lifecycle fields Towercab writes (INT-5).
  stage: string | null;
  waiting: string | null;
  specPr: string | null;
  planPr: string | null;
  pr: string | null;
  retry: string | null;
  cost: number | null;
  agentTime: number | null;
  attempts: number | null;
  finished: string | null;
  lowerWhy: string | null;
  /** `no` when the change merged but could not be checked live (SHIP-21); absent otherwise. */
  verified?: string | null;
  /** `2 of 3` while the change waits on the owner's steps (UI-163); absent otherwise. */
  stepsLeft?: string | null;
  /** `## <title>` → body text (trimmed), in file order. */
  sections: Map<string, string>;
  /** The whole file, as read. */
  text: string;
}

export interface Unreadable {
  path: string;
  reason: string;
  id: string | null;
}

/** Everything in the intents repo at one read. */
export interface Listing {
  /** Open intents (in `intents/`), in priority order (PRI-4). */
  open: Intent[];
  /** Done or dropped intents (in `done/`), newest first. */
  done: Intent[];
  unreadable: Unreadable[];
  /** IDs that count as done for `after` (done/ minus dropped, plus done/legacy.md). */
  doneIds: Set<string>;
  /** IDs dropped. */
  droppedIds: Set<string>;
  /** The checkout's `origin/main` sha when read. */
  head: string;
}

export interface NewIntent {
  repo: string;
  title: string;
  u?: number;
  i?: number;
  a?: number;
  /** Written as `source` (default `me`). */
  source?: string;
  /** More front-matter lines, written after `source` (`issue`, INT-23). */
  fields?: Record<string, string>;
  /** Markdown after the title (`## Problem`, …). */
  body?: string;
  /** A commit trailer that `hasMark` finds (INT-12). */
  mark?: string;
}

/** One change to an intent through the store (INT-5's field writes, sections, answers). */
export interface IntentEdit {
  setField(key: string, value: string | number | string[] | null): void;
  removeField(key: string): void;
  /** Replace `## <title>` whole; empty text removes it. */
  setSection(title: string, text: string): void;
  /** Append `- <time>: <text>` to `## Answers`. */
  addAnswer(text: string, at: Date): void;
  /** Replace the title line only (INT-34). */
  setTitle(title: string): void;
  readonly intent: Intent;
}

export interface IntentStore {
  list(): Promise<Listing>;
  get(idOrSuffix: string): Promise<Intent>;
  add(n: NewIntent, now: Date): Promise<Intent>;
  /**
   * Apply `fn` to the intent and push (`towercab: <what> <id>`); `mark` ends the commit message as a
   * trailer that `hasMark` finds. A thrown error writes nothing.
   */
  update(idOrSuffix: string, what: string, fn: (e: IntentEdit) => void, mark?: string): Promise<Intent>;
  hasMark(mark: string): Promise<boolean>;
  /** Read a file in the intents repo's `main` (e.g. a plan.md), or null. */
  readFile(path: string): Promise<string | null>;
  /**
   * INT-37: change `features/<repo>.md` and push (`towercab: features <repo> <what>`). `fn` gets the
   * file's text (null: none yet) and returns the new text, or null to leave it; it runs again on a
   * fresh `main` after a rejected push. True when a change was pushed.
   */
  editFeatures(repo: string, what: string, fn: (text: string | null) => string | null): Promise<boolean>;
  /**
   * UI-143: `features/<repo>.md` as the local checkout has it, without a pull or the lock (the page reads
   * it often, and offline too); null when there is none. The last `list()` keeps the checkout fresh.
   */
  localFeatures(repo: string): Promise<string | null>;
  /** The intents repo on GitHub (`owner/name`), or null when its remote isn't GitHub. */
  github(): string | null;
  /** The intent file's URL on GitHub, or null. */
  url(i: Intent): string | null;
}

export class SyncError extends Error {}
export class RefusedError extends Error {}
