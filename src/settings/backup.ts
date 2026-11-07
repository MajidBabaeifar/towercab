// The backup before every apply and the restore after it (REPO-31), both as the owner (REPO-39): everything the script can change,
// saved as JSON under `<home>/settings-backups/<owner>/<name>/`, the last 5 kept.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config.ts";
import { ForgeDenied, type SettingsSnapshot } from "../forge.ts";
import { forgeOf } from "../github/forge.ts";
import type { SettingsDeps } from "./script.ts";

export const KEEP = 5;

/** GitHub refused a read the backup needs: the owner's login can't see this repo's settings (REPO-40). */
export { ForgeDenied as ForbiddenError };

export interface Backup extends SettingsSnapshot {
  version: 1;
  repo: string;
  at: string;
}

const dirOf = (d: SettingsDeps, repo: RepoConfig) =>
  join(d.home.root, "settings-backups", ...repo.github.split("/"));

/** Save everything the script can change; throws when any part can't be read or the file can't be written. */
export async function saveBackup(
  d: SettingsDeps,
  repo: RepoConfig,
  extraBranches: string[] = [],
): Promise<string> {
  const snap = await forgeOf(d.github).asOwner().readSettings(repo.github, repo.base, extraBranches);
  const at = new Date(d.clock.now() * 1000);
  const backup: Backup = { version: 1, repo: repo.github, at: at.toISOString(), ...snap };
  const dir = dirOf(d, repo);
  mkdirSync(dir, { recursive: true });
  const name = `${at.toISOString().replace(/[-:.]/g, "")}.json`;
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(backup, null, 2), { mode: 0o600 });
  renameSync(tmp, join(dir, name));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP))) rmSync(join(dir, old));
  return join(dir, name);
}

export function newestBackup(d: SettingsDeps, repo: RepoConfig): Backup | null {
  const dir = dirOf(d, repo);
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .sort();
  } catch {
    return null;
  }
  const last = files.at(-1);
  if (!last) return null;
  return JSON.parse(readFileSync(join(dir, last), "utf8")) as Backup;
}

/**
 * Write back only what the newest backup saved. Rules added since (rulesets, protection the backup lacks)
 * stay and are listed. A forbidden write throws the permission message; any other failed part is listed.
 */
export async function restoreBackup(d: SettingsDeps, repo: RepoConfig): Promise<string[]> {
  const b = newestBackup(d, repo);
  if (!b) throw new Error(`${repo.name} has no saved settings`);
  const out = await forgeOf(d.github).asOwner().restoreSettings(repo.github, b);
  out.push(`From the backup of ${b.at}`);
  return out;
}
