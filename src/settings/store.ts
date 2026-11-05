// What Towercab remembers of the standard GitHub settings (REPO-30..32), in `meta`: the last check of
// each repo (`settings:<repo>`) and the one installation-wide missing permission (`settings-permission`).

import type { Db } from "../db.ts";

/** A repo's checked settings: `ok`, `gaps` (the script's lines) or `unknown` (never checked). */
export interface StoredSettings {
  state: "ok" | "gaps" | "unknown";
  gaps: string[];
  /** The `ci` release the script ran from. */
  tag: string | null;
  /** Unix seconds of the last check. */
  at: number;
  /** Why the last check could not run or why something was held back; the result above stays. */
  note?: string;
  /** REPO-31: why the ruleset was not applied. */
  ruleset?: string;
}

export const DAY_S = 86_400;

const key = (repo: string) => `settings:${repo}`;

export function storedSettings(db: Db, repo: string): StoredSettings | null {
  const raw = db.meta(key(repo));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredSettings>;
    if (v.state !== "ok" && v.state !== "gaps" && v.state !== "unknown") return null;
    return {
      state: v.state,
      gaps: Array.isArray(v.gaps) ? v.gaps.map(String) : [],
      tag: typeof v.tag === "string" ? v.tag : null,
      at: Number(v.at) || 0,
      ...(typeof v.note === "string" ? { note: v.note } : {}),
      ...(typeof v.ruleset === "string" ? { ruleset: v.ruleset } : {}),
    };
  } catch {
    return null;
  }
}

export function saveSettings(db: Db, repo: string, s: StoredSettings): void {
  db.setMeta(key(repo), JSON.stringify(s));
}

/** REPO-32: the App could not change settings; one flag for the installation, with the first repo it hit. */
export interface MissingPermission {
  at: number;
  repo: string;
}

export function missingPermission(db: Db): MissingPermission | null {
  const raw = db.meta("settings-permission");
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as MissingPermission;
    return { at: Number(v.at) || 0, repo: String(v.repo ?? "") };
  } catch {
    return { at: 0, repo: "" };
  }
}

export function setMissingPermission(db: Db, repo: string, at: number): void {
  if (!db.meta("settings-permission"))
    db.setMeta("settings-permission", JSON.stringify({ at, repo } satisfies MissingPermission));
}

/** The owner's one step for it; ticking clears the flag and makes repos with gaps due again. */
export const PERMISSION_STEP = "Grant the Towercab GitHub App the Administration (write) permission";

export function grantPermission(db: Db): boolean {
  const had = db.meta("settings-permission") !== null;
  db.delMeta("settings-permission");
  for (const row of db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'settings:%'")) {
    const repo = row.key.slice("settings:".length);
    const s = storedSettings(db, repo);
    if (s?.state === "gaps") saveSettings(db, repo, { ...s, at: 0 });
  }
  return had;
}

/** The permission line `doctor` prints, or null. */
export function permissionLine(db: Db): string | null {
  return missingPermission(db)
    ? "GitHub App lacks Administration (write): grant it at https://github.com/settings/apps so Towercab can apply settings"
    : null;
}
