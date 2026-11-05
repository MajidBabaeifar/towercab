// The backup before every apply and the restore after it (REPO-31): everything the script can change,
// saved as JSON under `<home>/settings-backups/<owner>/<name>/`, the last 5 kept.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoConfig } from "../config.ts";
import type { RunResult } from "../tools.ts";
import { forbidden, type SettingsDeps } from "./script.ts";

export const KEEP = 5;

// biome-ignore lint/suspicious/noExplicitAny: GitHub's JSON, read field by field
type Json = Record<string, any>;

export interface Backup {
  version: 1;
  repo: string;
  at: string;
  defaultBranch: string;
  /** `gh api repos/<r>`. */
  repository: Json;
  securityAndAnalysis: Json | null;
  rulesets: Json[];
  /** Classic branch protection by branch; null: the branch has none. */
  protection: Record<string, Json | null>;
  /** `actions/permissions/workflow`; null: absent. */
  workflow: Json | null;
  /** Vulnerability alerts on (`vulnerability-alerts` answers 204). */
  vulnerabilityAlerts: boolean;
}

const dirOf = (d: SettingsDeps, repo: RepoConfig) =>
  join(d.home.root, "settings-backups", ...repo.github.split("/"));
const notFound = (r: RunResult) => /\b404\b|Not Found/i.test(`${r.stderr}\n${r.stdout}`);

async function api(
  d: SettingsDeps,
  repo: RepoConfig,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<RunResult> {
  const args = ["api", `repos/${repo.github}${path}`];
  if (method !== "GET") args.push("-X", method);
  if (body !== undefined) args.push("--input", "-");
  return d.github.gh(repo.github, args, body !== undefined ? { input: JSON.stringify(body) } : {});
}

/** A read that must work, or 404 (null). Anything else fails the whole backup. */
async function read(d: SettingsDeps, repo: RepoConfig, path: string): Promise<Json | null> {
  const r = await api(d, repo, path);
  if (r.code === 0) {
    try {
      return r.stdout.trim() ? (JSON.parse(r.stdout) as Json) : {};
    } catch {
      throw new Error(`${path || "repository"}: not JSON`);
    }
  }
  if (notFound(r)) return null;
  throw new Error(
    `${path || "repository"}: ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`}`,
  );
}

/** Save everything the script can change; throws when any part can't be read or the file can't be written. */
export async function saveBackup(
  d: SettingsDeps,
  repo: RepoConfig,
  extraBranches: string[] = [],
): Promise<string> {
  const repository = await read(d, repo, "");
  if (!repository) throw new Error("repository: not found");
  const defaultBranch = String(repository.default_branch ?? repo.base);
  const list = (await read(d, repo, "/rulesets")) as unknown as Json[] | null;
  const rulesets: Json[] = [];
  for (const rs of list ?? []) {
    const full = await read(d, repo, `/rulesets/${rs.id}`);
    if (full) rulesets.push(full);
  }
  const protection: Record<string, Json | null> = {};
  for (const b of new Set([defaultBranch, ...extraBranches])) {
    protection[b] = await read(d, repo, `/branches/${encodeURIComponent(b)}/protection`);
  }
  const workflow = await read(d, repo, "/actions/permissions/workflow");
  const va = await api(d, repo, "/vulnerability-alerts");
  if (va.code !== 0 && !notFound(va))
    throw new Error(`vulnerability-alerts: ${va.stderr.trim().split("\n")[0]}`);
  const at = new Date(d.clock.now() * 1000);
  const backup: Backup = {
    version: 1,
    repo: repo.github,
    at: at.toISOString(),
    defaultBranch,
    repository,
    securityAndAnalysis: (repository.security_and_analysis as Json | undefined) ?? null,
    rulesets,
    protection,
    workflow,
    vulnerabilityAlerts: va.code === 0,
  };
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

const SETTINGS_KEYS = [
  "allow_squash_merge",
  "allow_merge_commit",
  "allow_rebase_merge",
  "allow_auto_merge",
  "allow_update_branch",
  "delete_branch_on_merge",
  "squash_merge_commit_title",
  "squash_merge_commit_message",
  "merge_commit_title",
  "merge_commit_message",
  "has_issues",
  "has_wiki",
  "has_projects",
  "web_commit_signoff_required",
];

const RULESET_KEYS = ["name", "target", "enforcement", "conditions", "rules", "bypass_actors"];

const enabled = (v: unknown): boolean =>
  v && typeof v === "object" ? Boolean((v as Json).enabled) : Boolean(v);
const logins = (xs: Json[] | undefined, key: string) => (xs ?? []).map((x) => x[key]);
const actors = (a: Json) => ({
  users: logins(a.users, "login"),
  teams: logins(a.teams, "slug"),
  apps: logins(a.apps, "slug"),
});

/** GitHub's protection as read → the body its PUT takes. */
export function protectionBody(p: Json): Json {
  const rsc = p.required_status_checks as Json | undefined;
  const rpr = p.required_pull_request_reviews as Json | undefined;
  return {
    required_status_checks: rsc
      ? {
          strict: Boolean(rsc.strict),
          checks: (
            (rsc.checks as Json[] | undefined) ??
            ((rsc.contexts as string[] | undefined) ?? []).map((context): Json => ({ context }))
          ).map((c) => ({ context: c.context, ...(c.app_id != null ? { app_id: c.app_id } : {}) })),
        }
      : null,
    enforce_admins: enabled(p.enforce_admins),
    required_pull_request_reviews: rpr
      ? {
          dismiss_stale_reviews: Boolean(rpr.dismiss_stale_reviews),
          require_code_owner_reviews: Boolean(rpr.require_code_owner_reviews),
          required_approving_review_count: rpr.required_approving_review_count ?? 1,
          require_last_push_approval: Boolean(rpr.require_last_push_approval),
          ...(rpr.dismissal_restrictions
            ? { dismissal_restrictions: actors(rpr.dismissal_restrictions) }
            : {}),
          ...(rpr.bypass_pull_request_allowances
            ? { bypass_pull_request_allowances: actors(rpr.bypass_pull_request_allowances) }
            : {}),
        }
      : null,
    restrictions: p.restrictions ? actors(p.restrictions as Json) : null,
    required_linear_history: enabled(p.required_linear_history),
    allow_force_pushes: enabled(p.allow_force_pushes),
    allow_deletions: enabled(p.allow_deletions),
    block_creations: enabled(p.block_creations),
    required_conversation_resolution: enabled(p.required_conversation_resolution),
    lock_branch: enabled(p.lock_branch),
    allow_fork_syncing: enabled(p.allow_fork_syncing),
  };
}

const pick = (o: Json, keys: string[]): Json =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/**
 * Write back only what the newest backup saved. Rules added since (rulesets, protection the backup lacks)
 * stay and are listed. A forbidden write throws the permission message; any other failed part is listed.
 */
export async function restoreBackup(d: SettingsDeps, repo: RepoConfig): Promise<string[]> {
  const b = newestBackup(d, repo);
  if (!b) throw new Error(`${repo.name} has no saved settings`);
  const out: string[] = [];
  const put = async (what: string, path: string, method: string, body?: unknown) => {
    const r = await api(d, repo, path, method, body);
    if (r.code === 0) out.push(`Restored ${what}`);
    else if (forbidden(r))
      throw new Error("the GitHub App lacks Administration (write): grant it, then run this again");
    else out.push(`Could not restore ${what}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  };
  const patch: Json = pick(b.repository, SETTINGS_KEYS);
  if (b.securityAndAnalysis) {
    patch.security_and_analysis = Object.fromEntries(
      Object.entries(b.securityAndAnalysis).map(([k, v]) => [k, { status: (v as Json).status }]),
    );
  }
  await put("the repository settings", "", "PATCH", patch);

  const now = ((await read(d, repo, "/rulesets")) as unknown as Json[] | null) ?? [];
  const nowIds = new Set(now.map((r) => r.id));
  for (const rs of b.rulesets) {
    const body = pick(rs, RULESET_KEYS);
    if (nowIds.has(rs.id)) await put(`ruleset ${rs.name}`, `/rulesets/${rs.id}`, "PUT", body);
    else await put(`ruleset ${rs.name} (recreated)`, "/rulesets", "POST", body);
  }
  const saved = new Set(b.rulesets.map((r) => r.id));
  for (const rs of now)
    if (!saved.has(rs.id)) out.push(`Not in the backup, left as it is: ruleset ${rs.name}`);

  for (const [branch, p] of Object.entries(b.protection)) {
    const path = `/branches/${encodeURIComponent(branch)}/protection`;
    if (p) await put(`branch protection of ${branch}`, path, "PUT", protectionBody(p));
    else if (await read(d, repo, path))
      out.push(`Not in the backup, left as it is: branch protection of ${branch}`);
  }
  if (b.workflow) {
    await put(
      "the workflow permissions",
      "/actions/permissions/workflow",
      "PUT",
      pick(b.workflow, ["default_workflow_permissions", "can_approve_pull_request_reviews"]),
    );
  }
  await put(
    `vulnerability alerts ${b.vulnerabilityAlerts ? "on" : "off"}`,
    "/vulnerability-alerts",
    b.vulnerabilityAlerts ? "PUT" : "DELETE",
  );
  out.push(`From the backup of ${b.at}`);
  return out;
}
