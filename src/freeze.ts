// LOOP-79: a freeze holds merges in the repos of one multi-repo intent. One `meta` row per repo
// (`freeze:<repo>`) names the mission, so the freeze survives a restart (LOOP-37). Nothing here
// touches GitHub: the freeze is Towercab's own record.

import type { Db } from "./db.ts";
import { finished } from "./machine.ts";
import { getMission } from "./mission.ts";

export interface Freeze {
  repo: string;
  mission: number;
  /** Unix seconds when the freeze was taken. */
  since: number;
}

const PREFIX = "freeze:";

export type Taken = { ok: true } | { ok: false; repo: string; heldBy: number };

function parse(repo: string, raw: string | null): Freeze | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { mission?: unknown; since?: unknown };
    if (typeof v.mission === "number" && typeof v.since === "number") {
      return { repo, mission: v.mission, since: v.since };
    }
  } catch {}
  return null;
}

/** Every freeze held now, by repo name. */
export function freezes(db: Db): Freeze[] {
  return db
    .all<{ key: string; value: string }>(
      "SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key",
      `${PREFIX}%`,
    )
    .flatMap((r) => parse(r.key.slice(PREFIX.length), r.value) ?? []);
}

/** The mission freezing `repo`, or null. A freeze whose mission has finished counts as lifted. */
export function frozenBy(db: Db, repo: string): number | null {
  const f = parse(repo, db.meta(`${PREFIX}${repo}`));
  if (!f) return null;
  const m = getMission(db, f.mission);
  return m && !finished(m.stage) ? f.mission : null;
}

/**
 * Freeze every repo for `mission` in one transaction, or none: if another mission holds any of them, nothing
 * is taken and the first held repo is named. Taking it again for the same mission keeps the first time.
 */
export function takeFreeze(db: Db, mission: number, repos: string[], now: number): Taken {
  return db.tx(() => {
    for (const repo of repos) {
      const by = frozenBy(db, repo);
      if (by !== null && by !== mission) return { ok: false, repo, heldBy: by };
    }
    for (const repo of repos) {
      const had = parse(repo, db.meta(`${PREFIX}${repo}`));
      const since = had && had.mission === mission ? had.since : now;
      db.setMeta(`${PREFIX}${repo}`, JSON.stringify({ mission, since }));
    }
    return { ok: true };
  });
}

/** Lift every freeze `mission` holds; the repos it freed. */
export function liftFreeze(db: Db, mission: number): string[] {
  return db.tx(() => {
    const mine = freezes(db).filter((f) => f.mission === mission);
    for (const f of mine) db.delMeta(`${PREFIX}${f.repo}`);
    return mine.map((f) => f.repo);
  });
}

/** Seconds the mission's freeze has lasted (the oldest of its repos), or null when it holds none. */
export function freezeAge(db: Db, mission: number, now: number): number | null {
  const since = freezes(db)
    .filter((f) => f.mission === mission)
    .map((f) => f.since);
  return since.length === 0 ? null : now - Math.min(...since);
}
