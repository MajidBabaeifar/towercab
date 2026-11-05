// What the settings job reads and writes of GitHub (REPO-31): repository settings, rulesets, branch protection,
// workflow permissions and vulnerability alerts, through `gh api`. The job itself is in `src/settings/`.

import { ForgeDenied, type Json, type SettingsSnapshot } from "../forge.ts";
import type { GitHub } from "../handlers.ts";
import type { RunResult } from "../tools.ts";

/** GitHub said no because the App can't change settings (not a network failure). */
export const forbidden = (r: RunResult): boolean =>
  /HTTP 403|Resource not accessible|Must have admin rights/i.test(`${r.stderr}\n${r.stdout}`);

const notFound = (r: RunResult) => /\b404\b|Not Found/i.test(`${r.stderr}\n${r.stdout}`);

/**
 * The repo's own rulesets from a paginated list: `gh --paginate --jq '.[]'` prints one object per line, a
 * plain array is read too. Rulesets inherited from an organisation are left out: they aren't this repo's.
 */
function rulesetList(text: string): Json[] {
  const t = text.trim();
  let all: Json[];
  try {
    const v = JSON.parse(t || "[]") as Json | Json[];
    all = Array.isArray(v) ? v : [v];
  } catch {
    all = t
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Json);
  }
  return all.filter((r) => r.source_type === undefined || r.source_type === "Repository");
}

async function api(
  gh: GitHub,
  repo: string,
  path: string,
  method = "GET",
  body?: unknown,
  paginate = false,
): Promise<RunResult> {
  const args = ["api", `repos/${repo}${path}`];
  if (paginate) args.push("--paginate", "--jq", ".[]");
  if (method !== "GET") args.push("-X", method);
  if (body !== undefined) args.push("--input", "-");
  return gh.gh(repo, args, body !== undefined ? { input: JSON.stringify(body) } : {});
}

/** A read that must work, or 404 (null). Anything else fails the whole backup. */
async function read(gh: GitHub, repo: string, path: string): Promise<Json | null> {
  const r = await api(gh, repo, path, "GET", undefined, path === "/rulesets");
  if (r.code === 0 && path === "/rulesets") return rulesetList(r.stdout) as unknown as Json;
  if (r.code === 0) {
    try {
      return r.stdout.trim() ? (JSON.parse(r.stdout) as Json) : {};
    } catch {
      throw new Error(`${path || "repository"}: not JSON`);
    }
  }
  if (notFound(r)) return null;
  if (forbidden(r)) throw new ForgeDenied(`${path || "repository"}: forbidden`);
  throw new Error(
    `${path || "repository"}: ${(r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`}`,
  );
}

/** Read everything the script can change; throws `ForgeDenied` when the App may not read part of it. */
export async function readSettings(
  gh: GitHub,
  repo: string,
  base: string,
  extraBranches: string[] = [],
): Promise<SettingsSnapshot> {
  const repository = await read(gh, repo, "");
  if (!repository) throw new Error("repository: not found");
  const defaultBranch = String(repository.default_branch ?? base);
  const list = (await read(gh, repo, "/rulesets")) as unknown as Json[] | null;
  const rulesets: Json[] = [];
  for (const rs of list ?? []) {
    const full = await read(gh, repo, `/rulesets/${rs.id}`);
    if (full) rulesets.push(full);
  }
  const protection: Record<string, Json | null> = {};
  for (const b of new Set([defaultBranch, ...extraBranches])) {
    protection[b] = await read(gh, repo, `/branches/${encodeURIComponent(b)}/protection`);
  }
  const workflow = await read(gh, repo, "/actions/permissions/workflow");
  const va = await api(gh, repo, "/vulnerability-alerts");
  if (forbidden(va)) throw new ForgeDenied("vulnerability-alerts: forbidden");
  if (va.code !== 0 && !notFound(va))
    throw new Error(`vulnerability-alerts: ${va.stderr.trim().split("\n")[0]}`);
  return {
    defaultBranch,
    repository,
    securityAndAnalysis: (repository.security_and_analysis as Json | undefined) ?? null,
    rulesets,
    protection,
    workflow,
    vulnerabilityAlerts: va.code === 0,
  };
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
 * Write back what a snapshot saved. A forbidden write throws the permission message; any other failed
 * part is listed.
 */
export async function restoreSettings(gh: GitHub, repo: string, b: SettingsSnapshot): Promise<string[]> {
  const out: string[] = [];
  const put = async (what: string, path: string, method: string, body?: unknown) => {
    const r = await api(gh, repo, path, method, body);
    if (r.code === 0) out.push(`Restored ${what}`);
    else if (forbidden(r))
      // What was restored before stays visible with the reason.
      throw new Error(
        [...out, "the GitHub App lacks Administration (write): grant it, then run this again"].join("\n"),
      );
    else out.push(`Could not restore ${what}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
  };
  const patch: Json = pick(b.repository, SETTINGS_KEYS);
  if (b.securityAndAnalysis) {
    patch.security_and_analysis = Object.fromEntries(
      Object.entries(b.securityAndAnalysis).map(([k, v]) => [k, { status: (v as Json).status }]),
    );
  }
  await put("the repository settings", "", "PATCH", patch);

  // A read that fails is listed like a write that fails; the rest still goes back.
  const tryRead = async (what: string, path: string): Promise<Json | null | undefined> => {
    try {
      return await read(gh, repo, path);
    } catch (e) {
      out.push(`Could not read ${what}: ${(e as Error).message}`);
      return undefined;
    }
  };
  const nowList = (await tryRead("the current rulesets", "/rulesets")) as unknown as
    | Json[]
    | null
    | undefined;
  const now = nowList ?? [];
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
    else if (await tryRead(`the branch protection of ${branch}`, path))
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
  return out;
}
