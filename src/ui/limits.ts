// A repo's limits on its page (UI-150 to UI-154): what the file says, what is pending in a pull
// request, the file's reason when it can't be read, and where the one-time move stands. Reads only
// the database; the loop's poll (REPO-15 to REPO-19) keeps it current.

import { DEFAULTS, errorKey, isMoved, readFileValues, readRecord, waitHours } from "../repo/settings.ts";
import type { UiSources } from "./state.ts";
import type { LimitsView } from "./view.ts";

/** UI-153: why the repo's `TOWERCAB.md` can't be read, or null. */
export function fileErrorOf(src: UiSources, repo: string): string | null {
  const why = src.db.meta(errorKey(repo));
  return why === null ? null : `TOWERCAB.md in ${repo} can't be read: ${why}`;
}

export function limitsView(src: UiSources, repo: string, now: number): LimitsView {
  const cfg = src.config.repos.get(repo);
  const file = readFileValues(src.db, repo) ?? {};
  const github = cfg?.github ?? "";
  const settings = readRecord(src.db, repo, "settings");
  const move = readRecord(src.db, repo, "move");
  const moved = isMoved(src.db, repo);
  const open = settings?.state === "open" ? settings : null;
  const hasGithub = github !== "" && !github.startsWith("gitlab:");
  return {
    values: { workers: cfg?.workers ?? DEFAULTS.workers, ahead: cfg?.ahead ?? DEFAULTS.ahead },
    defaults: { ...DEFAULTS },
    inFile: { workers: file.workers !== undefined, ahead: file.ahead !== undefined },
    pending: open ? { pr: open.pr, url: src.prUrl(github, open.pr), changes: open.changes } : null,
    moved,
    envNames: Object.keys(cfg?.env ?? {}).sort(),
    waitHours: waitHours(src.db, now),
    fileError: fileErrorOf(src, repo),
    fileUrl: hasGithub ? `https://github.com/${github}/blob/${cfg?.base ?? "main"}/TOWERCAB.md` : null,
    move: {
      state: moved
        ? "moved"
        : move?.state === "open"
          ? "open"
          : move?.state === "closed"
            ? "closed"
            : "waiting",
      pr: move && !moved ? move.pr : null,
      url: move && !moved ? src.prUrl(github, move.pr) : null,
      canOpen: src.running && !moved && move?.state !== "open",
    },
    canSave: src.running,
  };
}
