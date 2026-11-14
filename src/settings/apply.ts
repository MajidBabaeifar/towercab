// The settings jobs (REPO-30, REPO-31, REPO-38..41). The daily pass only reads: it checks every repo with the
// pinned `ci` script and stores the answer with the plan. `applySettings` is the owner's click: guard, backup,
// apply and check again, all with the owner's own `gh` login. Nothing else ever runs the script to change anything.

import { ensureClone } from "../checkout.ts";
import { tickSteps } from "../commands.ts";
import { clonePath, type RepoConfig } from "../config.ts";
import { isGitlab } from "../forge/types.ts";
import { forgeOf } from "../github/forge.ts";
import type { RunResult } from "../tools.ts";
import { ForbiddenError, saveBackup } from "./backup.ts";
import { mainGreen, parsePlan, planChanges } from "./guard.ts";
import {
  type As,
  CI_REPO,
  firstLine,
  forbidden,
  type Script,
  type SettingsDeps,
  SettingsUnknown,
  withScript,
} from "./script.ts";
import { DAY_S, type StoredSettings, saveSettings, storedSettings } from "./store.ts";

const FETCH_EVERY_S = 600;

const gapLines = (stdout: string, stderr: string): string[] => {
  const lines = (stdout.trim() || stderr.trim())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines : ["The standard settings differ"];
};

/** The one result of `--check`: null for `ok`, the gap lines, or throw `SettingsUnknown`. */
function gapsOf(r: RunResult): string[] | null {
  if (r.code === 0) return null;
  if (r.code !== 1) throw new SettingsUnknown(firstLine(r));
  return gapLines(r.stdout, r.stderr);
}

/** A read-only run as the App; when GitHub refuses it, once more as the owner (REPO-41). Never a write. */
async function read(s: Script, mode: "check" | "plan", first: As): Promise<{ r: RunResult; as: As }> {
  const r = await s.run(mode, first);
  if (first === "owner" || !forbidden(r)) return { r, as: first };
  return { r: await s.run(mode, "owner"), as: "owner" };
}

/** REPO-30, REPO-38: check one repo (and read its plan when it has gaps), as the App or, if refused, the owner. */
async function checkRepo(s: Script, at: number, first: As = "app"): Promise<StoredSettings> {
  const base = { tag: s.tag, at };
  const c = await read(s, "check", first);
  const gaps = gapsOf(c.r);
  if (!gaps) return { state: "ok", gaps: [], ...base };
  const plan = planChanges((await read(s, "plan", c.as)).r);
  return { state: "gaps", gaps, ...base, ...(plan ? { plan } : {}) };
}

/** The daily turn of one repo: only reads. Always stores a result. */
export async function settingsPass(d: SettingsDeps, repo: RepoConfig): Promise<StoredSettings> {
  const now = Math.floor(d.clock.now());
  const prev = storedSettings(d.db, repo.name);
  let result: StoredSettings;
  try {
    result = await withScript(d, repo, (s) => checkRepo(s, now));
  } catch (e) {
    if (!(e instanceof SettingsUnknown)) d.log(`settings of ${repo.name}: ${(e as Error).message}`);
    result = unknownResult(prev, now, e as Error);
  }
  saveSettings(d.db, repo.name, result);
  return result;
}

/** The last result stands (REPO-27); only the time and the reason change. */
function unknownResult(prev: StoredSettings | null, now: number, e: Error): StoredSettings {
  const why = `The standard settings could not be checked: ${e.message}`;
  return prev
    ? { ...prev, at: now, note: why }
    : { state: "unknown", gaps: [], tag: null, at: now, note: why };
}

/** REPO-39: repos whose Apply is running now; a second click is refused. */
const applying = new Set<string>();
export const isApplying = (repo: string): boolean => applying.has(repo);

const cannot = (github: string) =>
  `Your GitHub login can't change this repo's settings: it needs admin on ${github}`;

const STEP_TEXT = /^apply the standard github settings\b/i;

/**
 * REPO-33: after an Apply ends `ok`, tick the "Apply the standard GitHub settings" steps of the repo's
 * unfinished missions that are delivered as steps.
 */
function tickSettingsSteps(d: SettingsDeps, repo: RepoConfig): void {
  const rows = d.db.all<{ intent: string; data: string }>(
    "SELECT intent, data FROM missions WHERE repo = ? AND stage NOT IN ('done','stopped','unverified')",
    repo.name,
  );
  for (const row of rows) {
    let data: { delivery?: string; steps?: { n: number; text: string; done_at: string | null }[] };
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (data.delivery !== "steps") continue;
    const ns = (data.steps ?? []).filter((x) => !x.done_at && STEP_TEXT.test(x.text)).map((x) => x.n);
    if (ns.length) tickSteps(d.db, row.intent, ns, true, new Date(d.clock.now() * 1000), true);
  }
}

/**
 * REPO-31, REPO-39, REPO-40: the owner's Apply for one repo: the guard, the backup, the script, then check
 * again, all as the owner. Throws when there is nothing to apply or an Apply is running; otherwise stores and
 * returns the result.
 */
export async function applySettings(d: SettingsDeps, repo: RepoConfig): Promise<StoredSettings> {
  const stored = storedSettings(d.db, repo.name);
  if (isGitlab(repo.github) || stored?.state !== "gaps")
    throw new Error(`${repo.name} has no settings gaps to apply`);
  if (applying.has(repo.name)) throw new Error(`The settings of ${repo.name} are being applied already`);
  applying.add(repo.name);
  const now = Math.floor(d.clock.now());
  const held = (note: string, extra: Partial<StoredSettings> = {}): StoredSettings => ({
    ...stored,
    note,
    ...extra,
  });
  try {
    const result = await withScript(d, repo, async (s) => {
      const plan = parsePlan(await s.run("plan", "owner"));
      const guard = await mainGreen(d, repo, plan);
      try {
        await saveBackup(d, repo, plan?.branches ?? []);
      } catch (e) {
        if (e instanceof ForbiddenError) return held(cannot(repo.github));
        return held(`Nothing applied: no backup (${(e as Error).message})`);
      }
      const r = await s.run(guard.ok ? "apply" : "skip-ruleset", "owner");
      if (forbidden(r)) {
        // REPO-31: the script may have changed some settings before GitHub refused, so what is stored comes
        // from a new check, never from the gaps seen before the apply.
        try {
          return {
            ...(await checkRepo(s, now, "owner")),
            note: cannot(repo.github),
            ...(guard.ok ? {} : { ruleset: guard.words }),
          };
        } catch {
          return held(
            `${cannot(repo.github)}. The apply may have stopped part-way, so the gaps shown may be out of date`,
          );
        }
      }
      if (!guard.ok && r.code === 2) {
        return held(`Nothing applied: this ci release has no --skip-ruleset (${firstLine(r)})`, {
          ruleset: guard.words,
        });
      }
      let after: StoredSettings;
      try {
        after = await checkRepo(s, now, "owner");
      } catch (e) {
        return held(`Applied, but not checked again: ${(e as Error).message}`);
      }
      const note = r.code === 0 ? undefined : `The apply ended with an error: ${firstLine(r)}`;
      return {
        ...after,
        ...(note ? { note } : {}),
        ...(guard.ok ? {} : { ruleset: guard.words }),
      } satisfies StoredSettings;
    });
    saveSettings(d.db, repo.name, result);
    if (result.state === "ok") tickSettingsSteps(d, repo);
    return result;
  } catch (e) {
    if (!(e instanceof SettingsUnknown)) d.log(`settings of ${repo.name}: ${(e as Error).message}`);
    const result = unknownResult(stored, now, e as Error);
    saveSettings(d.db, repo.name, result);
    return result;
  } finally {
    applying.delete(repo.name);
  }
}

/** The repo whose daily check is due and oldest (never checked first), or null. */
export function nextSettingsDue(d: SettingsDeps): RepoConfig | null {
  let best: { repo: RepoConfig; at: number } | null = null;
  const now = d.clock.now();
  for (const repo of d.config.repos.values()) {
    // GL-3: the standard settings are GitHub's; a GitLab repo has none to check.
    if (isGitlab(repo.github)) continue;
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
