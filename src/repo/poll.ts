// Keeping the repos' `TOWERCAB.md` limits current (REPO-15 to REPO-19): fetch each repo, read the file
// from the base branch, remember the last good values or why it can't be read, follow the settings and
// move pull requests, and open the one-time move once the wait is over.

import { join } from "node:path";
import { clonePath } from "../config.ts";
import { parseTowercab, RepoError, readBaseFiles } from "./files.ts";
import {
  loadOverlay,
  loadRepoFilesWith,
  type Overlay,
  overlayDir,
  overlayLimits,
  replacedChecks,
  type SettingRow,
  settingRows,
} from "./overlay.ts";
import {
  baseText,
  errorKey,
  fetchBase,
  fileKey,
  isMoved,
  movedKey,
  moveKey,
  moveRepo,
  type PrKind,
  type PrRecord,
  prKey,
  readRecord,
  type SettingsEnv,
  waitHours,
} from "./settings.ts";

/** The reason without the file prefix the parser adds. */
export function reasonOf(message: string): string {
  return message.replace(/^(?:TOWERCAB\.md: )?(?:front matter: )?/, "");
}

/**
 * REPO-49: the repo has checks of its own and so does the overlay: say so once per pair (a Telegram
 * message and the page's notice card), naming both. Nothing else changes.
 */
async function overlayNotice(
  d: SettingsEnv,
  name: string,
  clone: string,
  base: string,
  ref: string,
): Promise<void> {
  const overlay = loadOverlay(d.configFile!, name);
  const replaced = replacedChecks(overlay ? await readBaseFiles(d.tools, clone, base, ref) : [], overlay);
  if (!replaced) {
    d.db.delMeta(noticeKey(name));
    return;
  }
  const text = `${name}: the repo now has its own checks (${replaced.file} on ${base}), so the overlay's checks in ${replaced.overlayFile} are no longer used.`;
  d.db.tx(() => {
    d.db.setMeta(noticeKey(name), JSON.stringify({ hash: replaced.hash, text }));
    if (d.db.meta(notifiedKey(name)) === replaced.hash) return;
    d.db.setMeta(notifiedKey(name), replaced.hash);
    d.db.run(
      "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, NULL, ?, ?)",
      `overlay-checks:${name}:${replaced.hash}`,
      text,
      d.now,
    );
  });
}

/** What the repo page shows of the settings in effect (UI-276), kept by the poll. */
export interface SettingsViewMeta {
  /** The overlay's `TOWERCAB.md` (where an overlay value is changed), or null without an overlay. */
  path: string | null;
  rows: SettingRow[];
  refusals: string[];
  /** An invalid overlay file's reason. */
  error: string | null;
}

export const viewKey = (repo: string): string => `settings-view:${repo}`;

/** UI-276: where each setting of the repo comes from, read from the base branch and the overlay. */
async function overlayView(
  d: SettingsEnv,
  name: string,
  clone: string,
  base: string,
  ref: string,
  slug: string,
): Promise<void> {
  let overlay: Overlay | null = null;
  try {
    overlay = loadOverlay(d.configFile!, name);
  } catch (e) {
    const dir = overlayDir(d.configFile!, name);
    const meta: SettingsViewMeta = {
      path: dir ? join(dir, "TOWERCAB.md") : null,
      rows: [],
      refusals: [],
      error: (e as Error).message,
    };
    d.db.setMeta(viewKey(name), JSON.stringify(meta));
    return;
  }
  try {
    const files = await loadRepoFilesWith(
      d.tools,
      clone,
      base,
      slug,
      overlay ?? { dir: "", towercab: null, verifying: null },
      ref,
    );
    const meta: SettingsViewMeta = {
      path: overlay ? join(overlay.dir, "TOWERCAB.md") : null,
      rows: settingRows(files),
      refusals: files.refusals ?? [],
      error: null,
    };
    d.db.setMeta(viewKey(name), JSON.stringify(meta));
  } catch (e) {
    const message = (e as Error).message;
    if (e instanceof RepoError && message.startsWith("overlay ")) {
      const meta: SettingsViewMeta = {
        path: overlay ? join(overlay.dir, "TOWERCAB.md") : null,
        rows: [],
        refusals: [],
        error: message,
      };
      d.db.setMeta(viewKey(name), JSON.stringify(meta));
    } else d.db.delMeta(viewKey(name));
  }
}

export const noticeKey = (repo: string): string => `overlay-notice:${repo}`;
const notifiedKey = (repo: string): string => `overlay-notified:${repo}`;

async function pollRepo(d: SettingsEnv, name: string, log: (l: string) => void): Promise<void> {
  const repo = d.repos.get(name);
  if (!repo) return;
  // PR states first: a PR seen merged is in the base branch the fetch below brings.
  const states = new Map<PrKind, string>();
  for (const kind of ["settings", "move"] as const) {
    const rec = readRecord(d.db, name, kind);
    if (rec?.state === "open") states.set(kind, (await d.forge.prBrief(repo.github, rec.pr)).state);
  }
  const clone = clonePath(repo, d.home);
  const ref = await fetchBase(d, repo, clone);
  let good = false;
  try {
    const text = await baseText(d.tools, clone, ref);
    const t = text === null ? null : parseTowercab(text);
    const values: Record<string, number> = {};
    if (t?.workers !== undefined) values.workers = t.workers;
    if (t?.ahead !== undefined) values.ahead = t.ahead;
    // REPO-46: a key the repo's file leaves out may come from the overlay, if it is stricter than the default.
    const o = d.configFile ? overlayLimits(d.configFile, name) : {};
    if (values.workers === undefined && o.workers !== undefined) values.workers = o.workers;
    if (values.ahead === undefined && o.ahead !== undefined) values.ahead = o.ahead;
    d.db.tx(() => {
      d.db.setMeta(fileKey(name), JSON.stringify(values));
      d.db.delMeta(errorKey(name));
    });
    good = true;
  } catch (e) {
    d.db.setMeta(errorKey(name), reasonOf((e as Error).message));
  }
  for (const [kind, state] of states) {
    const rec = readRecord(d.db, name, kind)!;
    if (state === "OPEN") continue;
    const merged = state === "MERGED";
    if (kind === "settings") {
      // A merged change counts once the file has been read after it.
      if (!merged || good) d.db.delMeta(prKey(name, kind));
    } else if (merged) {
      if (!good) continue;
      d.db.tx(() => {
        d.db.setMeta(prKey(name, kind), JSON.stringify({ ...rec, state: "merged" } satisfies PrRecord));
        d.db.setMeta(movedKey(name), String(Math.floor(d.now)));
      });
    } else {
      d.db.setMeta(prKey(name, kind), JSON.stringify({ ...rec, state: "closed" } satisfies PrRecord));
    }
  }
  if (d.configFile) {
    await overlayView(d, name, clone, repo.base, ref, repo.github).catch(() => undefined);
    await overlayNotice(d, name, clone, repo.base, ref).catch(() => undefined);
  }
  // REPO-19: the move, on its own, once the wait is over; asked once per repo.
  if (good && !isMoved(d.db, name) && d.db.meta(moveKey(name)) === null && waitHours(d.db, d.now) === null) {
    const out = await moveRepo(d, name);
    log(
      out ? `opened PR #${out.pr} to move ${name}'s settings into TOWERCAB.md` : `${name}: nothing to move`,
    );
  }
}

/** One pass over every repo; one failing repo doesn't stop the others. */
export async function pollRepoSettings(d: SettingsEnv, log: (l: string) => void): Promise<void> {
  for (const name of [...d.repos.keys()]) {
    try {
      await pollRepo(d, name, log);
    } catch (e) {
      log(`settings of ${name}: ${(e as Error).message}`);
    }
  }
}
