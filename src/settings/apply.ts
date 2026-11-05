// The daily settings job (REPO-30, REPO-31): check every repo with the pinned `ci` script, store the
// answer, and with the owner's opt-in apply it behind the ruleset guard and a backup, then check again.

import { ensureClone } from "../checkout.ts";
import { clonePath, type RepoConfig } from "../config.ts";
import { forgeOf } from "../github/forge.ts";
import { parseTowercab } from "../repo/files.ts";
import { ForbiddenError, saveBackup } from "./backup.ts";
import { mainGreen, parsePlan } from "./guard.ts";
import {
  CI_REPO,
  firstLine,
  forbidden,
  type Script,
  type SettingsDeps,
  SettingsUnknown,
  withScript,
} from "./script.ts";
import {
  DAY_S,
  missingPermission,
  type StoredSettings,
  saveSettings,
  setMissingPermission,
  storedSettings,
} from "./store.ts";

const FETCH_EVERY_S = 600;

const gapLines = (stdout: string, stderr: string): string[] => {
  const lines = (stdout.trim() || stderr.trim())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines : ["The standard settings differ"];
};

/** REPO-31: may Towercab apply here? A `settings: check` line in the repo's `TOWERCAB.md` says no. */
async function mayApply(d: SettingsDeps, repo: RepoConfig): Promise<boolean> {
  if (d.config.githubSettings !== "apply") return false;
  let text: string | null;
  try {
    text = await forgeOf(d.github).readFile(repo.github, "TOWERCAB.md", repo.base);
  } catch {
    return false;
  }
  // No file: nothing says check-only.
  if (text === null) return true;
  try {
    return parseTowercab(text).settings !== "check";
  } catch {
    // A file that can't be read is check-only: the safe side.
    return false;
  }
}

/** Run the check once: null for `ok`, the gap lines, or throw `SettingsUnknown`. */
async function check(s: Script): Promise<string[] | null> {
  const r = await s.run("check");
  if (r.code === 0) return null;
  if (r.code !== 1) throw new SettingsUnknown(firstLine(r));
  return gapLines(r.stdout, r.stderr);
}

/** One repo's turn: check, and when allowed apply and check again. Always stores a result. */
export async function settingsPass(d: SettingsDeps, repo: RepoConfig): Promise<StoredSettings> {
  const now = Math.floor(d.clock.now());
  const prev = storedSettings(d.db, repo.name);
  let result: StoredSettings;
  try {
    result = await withScript(d, repo, async (s) => {
      const gaps = await check(s);
      const base = { tag: s.tag, at: now };
      if (!gaps) return { state: "ok" as const, gaps: [], ...base };
      const found: StoredSettings = { state: "gaps", gaps, ...base };
      if (missingPermission(d.db) || !(await mayApply(d, repo))) return found;

      const plan = parsePlan(await s.run("plan"));
      const guard = await mainGreen(d, repo, plan);
      try {
        await saveBackup(d, repo, plan?.branches ?? []);
      } catch (e) {
        // An App without Administration can't read protection or alerts: that is the missing permission.
        if (e instanceof ForbiddenError) {
          setMissingPermission(d.db, repo.name, now);
          return { ...found, note: "Nothing applied: the GitHub App lacks Administration (write)" };
        }
        return { ...found, note: `Nothing applied: no backup (${(e as Error).message})` };
      }
      const r = await s.run(guard.ok ? "apply" : "skip-ruleset");
      if (forbidden(r)) {
        setMissingPermission(d.db, repo.name, now);
        return { ...found, note: "Nothing applied: the GitHub App lacks Administration (write)" };
      }
      if (!guard.ok && r.code === 2) {
        return {
          ...found,
          note: `Nothing applied: this ci release has no --skip-ruleset (${firstLine(r)})`,
          ruleset: guard.words,
        };
      }
      let after: string[] | null;
      try {
        after = await check(s);
      } catch (e) {
        return { ...found, note: `Applied, but not checked again: ${(e as Error).message}` };
      }
      const note = r.code === 0 ? undefined : `The apply ended with an error: ${firstLine(r)}`;
      return {
        state: after ? "gaps" : "ok",
        gaps: after ?? [],
        ...base,
        ...(note ? { note } : {}),
        ...(guard.ok ? {} : { ruleset: guard.words }),
      } satisfies StoredSettings;
    });
  } catch (e) {
    if (!(e instanceof SettingsUnknown)) d.log(`settings of ${repo.name}: ${(e as Error).message}`);
    const why = `The standard settings could not be checked: ${(e as Error).message}`;
    // The last result stands (REPO-27); only the time and the reason change.
    result = prev
      ? { ...prev, at: now, note: why }
      : { state: "unknown", gaps: [], tag: null, at: now, note: why };
  }
  saveSettings(d.db, repo.name, result);
  return result;
}

/** The repo whose daily check is due and oldest (never checked first), or null. */
export function nextSettingsDue(d: SettingsDeps): RepoConfig | null {
  let best: { repo: RepoConfig; at: number } | null = null;
  const now = d.clock.now();
  for (const repo of d.config.repos.values()) {
    const at = storedSettings(d.db, repo.name)?.at ?? 0;
    if (at !== 0 && now - at < DAY_S) continue;
    if (!best || at < best.at) best = { repo, at };
  }
  return best?.repo ?? null;
}

/** Fetch the ci clone (at most every 10 minutes), then run the oldest due repo. Its name, or null. */
export async function settingsCycle(d: SettingsDeps): Promise<string | null> {
  const repo = nextSettingsDue(d);
  if (!repo) return null;
  const ci = d.config.repos.get(CI_REPO);
  const at = Number(d.db.meta("settings-fetched") ?? 0);
  if (ci && d.clock.now() - at >= FETCH_EVERY_S) {
    try {
      await (d.exclusive ?? ((fn) => fn()))(async () =>
        ensureClone(d.tools, clonePath(ci, d.home.root), ci, await d.github.gitAuth(ci.github)),
      );
      d.db.setMeta("settings-fetched", String(Math.floor(d.clock.now())));
    } catch (e) {
      d.log(`settings: fetching ci failed: ${(e as Error).message}`);
    }
  }
  await settingsPass(d, repo);
  return repo.name;
}
