// LOOP-76: an exit that would close an open code PR with commits asks for one confirmation first.

import type { Db } from "./db.ts";
import type { Forge } from "./forge.ts";
import type { IntentStore } from "./intents/types.ts";
import type { ExitKind } from "./machine.ts";
import { unfinishedFor } from "./mission.ts";

/** What the owner is told before the PR is closed. `commits` is null when the PR could not be read. */
export interface ExitWarning {
  pr: number;
  commits: number | null;
  text: string;
}

/** The exits that end the intent or change its delivery, and so close its open code PR. */
export const CLOSING_EXITS: ExitKind[] = ["done", "steps", "drop"];

export const closesPr = (exit: string): boolean => (CLOSING_EXITS as string[]).includes(exit);

const commitsOf = (n: number): string => `${n} ${n === 1 ? "commit" : "commits"}`;

export const warningText = (pr: number, commits: number): string =>
  `This closes PR #${pr} (${commitsOf(commits)}) and deletes its branch. Nothing is merged.`;

/** The PR could not be read: the owner still confirms, on a general warning. */
export const generalWarningText = (): string =>
  "Couldn't check the PR; it may have commits. It will be closed and its branch deleted.";

/** The short question of a confirm button: `Close PR #12 with 3 commits?` */
export const closeQuestion = (w: ExitWarning): string =>
  w.commits === null
    ? `Close PR #${w.pr}? It may have commits.`
    : `Close PR #${w.pr} with ${commitsOf(w.commits)}?`;

/** The refusal an exit without its confirmation gets. */
export class ExitNeedsConfirm extends Error {
  readonly warning: ExitWarning;
  constructor(warning: ExitWarning) {
    super(warning.text);
    this.warning = warning;
  }
}

/**
 * The warning for closing `pr` of `github`, or null when nothing is lost: no open PR, or one with no commits.
 * A host that cannot be read never blocks the exit; it gets the general warning.
 */
export async function exitWarning(
  forge: Pick<Forge, "prCommits"> | null,
  github: string | null,
  pr: number | null,
): Promise<ExitWarning | null> {
  if (pr === null || !github) return null;
  const general: ExitWarning = { pr, commits: null, text: generalWarningText() };
  if (!forge) return general;
  try {
    const r = await forge.prCommits(github, pr);
    if (r.state !== "OPEN" || r.commits === 0) return null;
    return { pr, commits: r.commits, text: warningText(pr, r.commits) };
  } catch {
    return general;
  }
}

/**
 * The command line's confirmation: an exit that would close an open code PR with commits is refused with the
 * warning unless `yes` (`--yes`). An intent with no running mission or no open PR needs none.
 */
export async function confirmExit(
  d: {
    db: Db;
    store: IntentStore;
    forge: Pick<Forge, "prCommits"> | null;
    githubOf: (repo: string) => string | null;
  },
  intent: string,
  yes: boolean,
): Promise<void> {
  if (yes) return;
  const found = await d.store.get(intent).catch(() => null);
  const m = found ? unfinishedFor(d.db, found.id) : undefined;
  if (!m?.pr) return;
  const w = await exitWarning(d.forge, d.githubOf(m.repo), m.pr);
  if (w) throw new Error(`${w.text}\nRun it again with --yes to go on.`);
}
