// What a stage handler is given and returns (LOOP-3, LOOP-6). One handler per stage
// (src/pipeline/index.ts); the loop calls `step` when a mission is due and `finish` when its child ends.

import type { Config, RepoConfig } from "./config.ts";
import type { Db, SqlValue } from "./db.ts";
import type { Forge } from "./forge.ts";
import type { Home } from "./home.ts";
import type { IntentStore } from "./intents/types.ts";
import type { Outcome } from "./machine.ts";
import type { Mission } from "./mission.ts";
import type { ChildExit, ChildSpec, RunOpts, RunResult, Tools } from "./tools.ts";

export interface Clock {
  /** Wall clock, unix seconds (fractional). */
  now(): number;
  /** Monotonic milliseconds (stops in suspend). */
  mono(): number;
}

export const systemClock: Clock = {
  now: () => Date.now() / 1000,
  mono: () => performance.now(),
};

/** GitHub as Towercab's App, and as the owner (LOOP-19, LOOP-38). src/github/ implements it. */
export interface GitHub {
  /** `gh` as the App for `owner/name` (GH_TOKEN = its installation token). */
  gh(github: string, args: string[], opts?: RunOpts): Promise<RunResult>;
  /** `gh` with the owner's own login (no token added). */
  owner(args: string[], opts?: RunOpts): Promise<RunResult>;
  /** `-c` args and env that make `git` push and fetch `https://github.com/<github>` as the App. */
  gitAuth(github: string): Promise<{ args: string[]; env: Record<string, string> }>;
  /** The App's bot user (commit author). */
  bot(): Promise<{ login: string; id: number; email: string }>;
  /** `[github].me`. */
  readonly me: string;
}

/**
 * What the loop holds: the forge, and, until the code that still makes raw `gh` calls (settings,
 * releases, secrets, readiness) has moved behind it, the raw calls too. Stages get the `Forge` alone
 * (`Ctx.github`, PIP-201).
 */
export type Host = Forge & GitHub;

export interface ChildEnd extends ChildExit {
  timedOut: boolean;
  /** Run time in ms. */
  runMs: number;
  stdout: string;
  stderr: string;
}

export type Progress =
  | { done: Outcome }
  /**
   * Run this child. `launched`: columns set only once it really starts; a spawn that waits for a free
   * slot (LOOP-4) is asked for again later, as if it had never been made.
   */
  | { spawn: ChildSpec; launched?: Record<string, SqlValue> }
  /** Come back after this many seconds (CI, a PR read). */
  | { poll: number };

export interface Ctx {
  config: Config;
  home: Home;
  db: Db;
  tools: Tools;
  clock: Clock;
  store: IntentStore;
  github: Forge;
  /** False right after a wake from suspend: no wait timeout may fire before its poll (LOOP-11). */
  timeouts: boolean;
  log(line: string): void;
  /** The mission's repo config (throws `unknown repo <r>`). */
  repo(m: Mission): RepoConfig;
  /** Absolute checkout path. */
  checkout(m: Mission): string;
  /** `runs/<intent>/`, or with a stage `runs/<intent>/<stage>/` (LOOP-39), created. */
  runs(m: Mission, stage?: string): string;
  /**
   * LOOP-6: store the step and the IDs it will use before the side effect it guards, in one
   * transaction; returns the fresh row. A new step resets `unclean` and `retries`.
   */
  record(m: Mission, step: string, set?: Record<string, SqlValue>, data?: Record<string, unknown>): Mission;
}

export interface Handler {
  /** Do or redo the step of `m.stage` from `m.step`; on re-entry check what the recorded step did. */
  step(cx: Ctx, m: Mission): Promise<Progress>;
  /** The child `step` spawned has ended. */
  finish(cx: Ctx, m: Mission, end: ChildEnd): Promise<Progress>;
}

export type Handlers = Partial<Record<Mission["stage"], Handler>>;

/** A network, auth or tool failure (LOOP-10): the step backs off and retries. */
export class EnvError extends Error {
  readonly fault: string;
  constructor(fault: string, message: string) {
    super(message);
    this.fault = fault;
  }
}
