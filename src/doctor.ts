// `towercab doctor` (LOOP-15, LOOP-20): what is missing to run, one line each. `--quick` is the
// self-update check (LOOP-35): config, tools and modules only, no network.

import { existsSync, statSync } from "node:fs";
import { type Capacity, readCapacity, slotHint } from "./capacity.ts";
import type { Config } from "./config.ts";
import { appKeyPath, clonePath } from "./config.ts";
import type { Db } from "./db.ts";
import { type GitLabForge, NEEDED_SCOPES } from "./forge/gitlab.ts";
import { GlabOwner } from "./forge/gitlab-owner.ts";
import { forgeOf } from "./github/forge.ts";
import { ghVersion, ghVersionOk } from "./github/gh.ts";
import { readRequired } from "./github/teammates.ts";
import type { GitHub } from "./handlers.ts";

export { ghVersionOk };

import type { Home } from "./home.ts";
import { parseStored } from "./repo/readiness.ts";
import { permissionLine } from "./settings/store.ts";
import { tooFewListed } from "./teammates.ts";
import type { Tools } from "./tools.ts";

export const TOOLS = ["git", "gh", "claude", "bwrap", "systemd-inhibit", "systemctl", "journalctl"];

export interface DoctorResult {
  lines: string[];
  ok: boolean;
}

export async function doctor(o: {
  config: Config;
  home: Home;
  tools: Tools;
  github: GitHub | null;
  /** GL-9: Towercab's GitLab, when `[gitlab]` is configured. */
  gitlab?: GitLabForge | null;
  quick: boolean;
  /** The database, for the readiness lines (LOOP-72). */
  db?: Db;
  /** Unix seconds and the machine's cores and memory, for the slots line (LOOP-104); real ones when absent. */
  now?: number;
  capacity?: Capacity;
}): Promise<DoctorResult> {
  const { config, home, tools } = o;
  const lines: string[] = [`config: ${config.file}`, `home: ${home.root}`, `node: ${process.version}`];
  let ok = true;
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  if (major < 22 || (major === 22 && minor < 18)) {
    lines.push("node: Towercab needs Node 22.18 or newer");
    ok = false;
  }
  for (const t of TOOLS) {
    const p = tools.which(t);
    lines.push(`${t}: ${p ?? "missing"}`);
    if (!p && t !== "journalctl") ok = false;
  }
  if (config.gitlab) {
    const p = tools.which("glab");
    lines.push(`glab: ${p ?? "missing"}`);
    if (!p) ok = false;
  }
  if (o.quick) return { lines, ok };

  const v = await ghVersion(tools);
  lines.push(`gh version: ${v.version}${v.ok ? "" : ": Towercab needs 2.46 or newer"}`);
  if (!v.ok) ok = false;
  const key = appKeyPath(config);
  if (!existsSync(key)) {
    lines.push(`github app: ${key} is missing (register the App from ops/github-app.json)`);
    ok = false;
  } else if ((statSync(key).mode & 0o077) !== 0) {
    lines.push(`github app: ${key} is readable by others: chmod 600 it`);
    ok = false;
  } else if (o.github) {
    try {
      const bot = await o.github.bot();
      lines.push(`github app: ${bot.login} ${bot.id}`);
    } catch (e) {
      lines.push(`github app: ${(e as Error).message}`);
      ok = false;
    }
  }
  if (o.github) {
    const me = config.github?.me ?? "";
    const logins = await forgeOf(o.github).ownerLogins();
    lines.push(
      me && logins.includes(me.toLowerCase())
        ? `gh login: ${me}`
        : `gh login: not logged in as ${me} (run gh auth login): the UI's actions need it`,
    );
  }
  // REPO-32: said once, and only while Towercab is meant to apply settings.
  const perm = o.db && config.githubSettings === "apply" ? permissionLine(o.db) : null;
  if (perm) lines.push(perm);
  if (config.gitlab && o.gitlab) {
    const g = await gitlabLines(o.gitlab, new GlabOwner(tools, config.gitlab), o.now ?? Date.now() / 1000);
    lines.push(...g.lines);
    if (!g.ok) ok = false;
  }
  for (const [name, repo] of config.repos) {
    lines.push(
      `${name}: ${repo.github} · ${existsSync(clonePath(repo, home.root)) ? "cloned" : "clones on first use"}`,
    );
  }
  // LOOP-72: repos with a missing or unknown item, and the waived ones.
  if (o.db) {
    for (const name of config.repos.keys()) {
      const r = parseStored(o.db.meta(`readiness:${name}`))?.readiness;
      if (!r) continue;
      const shown = r.items.filter((i) => i.state !== "present");
      if (r.ready && shown.length === 0) continue;
      lines.push(
        `${name}: ${r.ready ? "ready" : `not ready, ${r.blocks ? "blocking new work" : "warning only"}`}`,
      );
      for (const i of shown)
        lines.push(
          `${name}: ${i.state === "waived" ? `waived ${i.item}: ${i.words}` : `${i.state} ${i.item}: ${i.words}`}`,
        );
    }
  }
  // LOOP-104: a hint (never a failure) when runs wait long for a slot and the machine has room.
  if (o.db) {
    const hint = slotHint({
      db: o.db,
      now: o.now ?? Date.now() / 1000,
      limit: config.agent.parallel,
      capacity: o.capacity ?? readCapacity(),
    });
    if (hint) lines.push(hint);
  }
  // LOOP-84: a warning (never a failure) when the host needs approvals that Towercab isn't waiting for.
  if (o.github) {
    for (const [name, repo] of config.repos) {
      const required = await readRequired(o.github, repo.github, repo.base);
      if (required === null || required < 1) continue;
      const plural = required === 1 ? "" : "s";
      if (!repo.teammateReview) {
        lines.push(
          `${name}: GitHub requires ${required} approval${plural} but teammate review is off: run towercab repo set ${name} teammate_review=on reviewers=<logins>`,
        );
      } else if (
        (repo.reviewers?.length ?? 0) > 0 &&
        tooFewListed(repo.reviewers ?? [], config.github?.me ?? "", required)
      ) {
        lines.push(
          `${name}: GitHub requires ${required} approvals but only ${repo.reviewers?.length} reviewers are listed: run towercab repo set ${name} reviewers=…`,
        );
      }
    }
  }
  for (const [name, why] of config.badRepos) lines.push(`${name}: ${why}`);
  // LOOP-65: a table for a repo in the database is ignored; it can go.
  for (const [name, why] of config.ignoredRepos) lines.push(`${name}: ${why}`);
  lines.push(
    `telegram: ${config.telegram ? `chat ${config.telegram.chatId}` : "not configured (no messages)"}`,
  );
  return { lines, ok };
}

const DAY_S = 86_400;
/** GL-9: warn this many days before the token expires. */
export const TOKEN_WARN_DAYS = 14;

/** GL-9: the token file, its scopes and expiry, and the owner's `glab` login. */
async function gitlabLines(
  gl: GitLabForge,
  owner: GlabOwner,
  now: number,
): Promise<{ lines: string[]; ok: boolean }> {
  const lines: string[] = [];
  let ok = true;
  try {
    gl.token();
    const bot = await gl.bot();
    lines.push(`gitlab token: ${bot.login} ${bot.id}`);
    const t = await gl.tokenInfo();
    for (const scope of NEEDED_SCOPES) {
      if (t.scopes.includes(scope)) continue;
      lines.push(
        `GitLab token lacks ${scope}: create a project or group access token with api and write_repository`,
      );
      ok = false;
    }
    const exp = t.expiresAt ? Date.parse(`${t.expiresAt}T23:59:59Z`) / 1000 : null;
    if (!t.active || (exp !== null && exp < now)) {
      lines.push(`GitLab token expired on ${t.expiresAt ?? "an earlier date"}: create a new one`);
      ok = false;
    } else if (exp !== null && exp - now < TOKEN_WARN_DAYS * DAY_S) {
      const days = Math.max(0, Math.floor((exp - now) / DAY_S));
      lines.push(`GitLab token expires in ${days} days (${t.expiresAt}): create a new one before then`);
    }
  } catch (e) {
    lines.push(`gitlab token: ${(e as Error).message}`);
    ok = false;
  }
  try {
    lines.push(`glab login: ${await owner.login()}`);
  } catch (e) {
    lines.push((e as Error).message);
    ok = false;
  }
  return { lines, ok };
}
