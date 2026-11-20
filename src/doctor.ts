// `towercab doctor` (LOOP-15, LOOP-20): what is missing to run, one line each. `--quick` is the
// self-update check (LOOP-35): config, tools and modules only, no network.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Capacity, readCapacity, slotHint } from "./capacity.ts";
import type { Config } from "./config.ts";
import { appKeyPath, clonePath, readTokenFile } from "./config.ts";
import type { Db } from "./db.ts";
import { type GitLabForge, NEEDED_SCOPES } from "./forge/gitlab.ts";
import { GlabOwner } from "./forge/gitlab-owner.ts";
import { forgeOf } from "./github/forge.ts";
import { ghVersion, ghVersionOk } from "./github/gh.ts";
import { readRequired } from "./github/teammates.ts";
import type { GitHub } from "./handlers.ts";

export { ghVersionOk };

import type { Home } from "./home.ts";
import { urlProblem } from "./notify-text.ts";
import { type HostState, hostState, profileStep } from "./pipeline/hostcheck.ts";
import { apparmorProfile, type ProbeResult, sandboxProbe, userNamespaceDenied } from "./pipeline/probe.ts";
import { refusedRepoEnv, toolchainBins, toolchainPlaces } from "./pipeline/sandbox.ts";
import { overlayDoctor } from "./repo/overlay.ts";
import { parseStored } from "./repo/readiness.ts";
import { isMoved, readRecord } from "./repo/settings.ts";
import { shipNetwork } from "./ship/live.ts";
import { tooFewListed } from "./teammates.ts";
import type { Tools } from "./tools.ts";
import {
  detectWsl,
  hasVmIdleTimeout,
  isUnderMnt,
  POWERSHELL,
  pid1IsSystemd,
  powershellPath,
  readWslConfig,
} from "./wsl.ts";

export const TOOLS = ["git", "gh", "claude", "bwrap", "systemd-inhibit", "systemctl", "journalctl"];

/** LOOP-143: a secrets file Towercab reads: the App key, the GitLab token, and `config.toml` when it holds one. */
export function looseSecretFiles(config: Config): string[] {
  const files = [appKeyPath(config)];
  if (config.gitlab) files.push(config.gitlab.tokenFile);
  if (config.telegram?.botToken) files.push(config.file);
  return files.filter((f) => {
    try {
      return (statSync(f).mode & 0o077) !== 0;
    } catch {
      return false;
    }
  });
}

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
  /** LOOP-145: the self-update's check; a loose secrets file is a warning there, not a failure. */
  forUpdate?: boolean;
  /** The HOME whose toolchains are listed (PIP-226); the real one when absent. */
  userHome?: string;
  /** The database, for the readiness lines (LOOP-72). */
  db?: Db;
  /** Unix seconds and the machine's cores and memory, for the slots line (LOOP-104); real ones when absent. */
  now?: number;
  capacity?: Capacity;
  /** The sandbox probe (PIP-163); the real one when absent. */
  probe?: () => Promise<ProbeResult>;
  /** The host's user-namespace state (PIP-162); the real one when absent. */
  host?: () => HostState;
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
  // PIP-157, PIP-159: keys that no longer reach the sandbox, and repo variables it leaves out.
  for (const k of config.agent.ignored) {
    lines.push(`config: [agent] ${k} is ignored: the sandbox's settings are fixed in code`);
  }
  for (const name of config.repos.keys()) {
    const extra = o.db ? shipNetwork(o.db, name) : [];
    if (extra.length) lines.push(`${name}: ship commands may also reach ${extra.join(", ")}`);
  }
  for (const [name, repo] of config.repos) {
    for (const r of refusedRepoEnv(repo.env)) {
      lines.push(`${name}: env ${r.name} is left out of the sandbox: ${r.why}`);
    }
  }
  // PIP-226: the toolchains the sandbox binds; a missing one is information, not a fault.
  const userHome = o.userHome ?? homedir();
  const bound = toolchainPlaces(userHome);
  const places = [".cargo/bin", ".rustup", ".local/go", ".local/zig-*", ".local/node"];
  for (const p of places) {
    if (p.endsWith("zig-*")) {
      const zigs = bound.filter((d) => d.startsWith(join(userHome, ".local", "zig-")));
      if (zigs.length === 0) lines.push(`toolchain ${join(userHome, p)}: not found`);
      for (const z of zigs) lines.push(`toolchain ${z}: bound`);
    } else {
      const d = join(userHome, p);
      lines.push(`toolchain ${d}: ${bound.includes(d) ? "bound" : "not found"}`);
    }
  }
  lines.push(`toolchain PATH: ${toolchainBins(userHome).join(":")}`);

  // LOOP-143: under WSL, what commonly breaks there; the `/mnt/` lines come before the secrets lines.
  const release = await detectWsl(tools);
  let wslSystemd = false;
  if (release !== null) {
    lines.push(`wsl: ${release}`);
    wslSystemd = await pid1IsSystemd(tools);
    if (!wslSystemd) {
      lines.push(
        "wsl: systemd is not PID 1: enable it with [boot] systemd=true in /etc/wsl.conf, then run wsl --shutdown",
      );
      ok = false;
    }
    const places: [string, string][] = [
      ["config", dirname(resolve(config.file))],
      ["home", resolve(home.root)],
      ...[...config.repos.values()].map((r): [string, string] => [r.name, resolve(clonePath(r, home.root))]),
    ];
    for (const [what, p] of places) {
      if (!isUnderMnt(p)) continue;
      lines.push(`wsl: ${what} ${p} is under /mnt/: keep it in the Linux file system (for example under ~)`);
      ok = false;
    }
  }
  // LOOP-143, LOOP-145: a secrets file others can read, on every platform.
  for (const f of looseSecretFiles(config)) {
    const fix =
      release !== null && isUnderMnt(resolve(f))
        ? `a /mnt/ path cannot hold mode 600: move it into the Linux file system`
        : `chmod 600 ${f}`;
    if (o.forUpdate) {
      lines.push(`warning: ${f} is readable by others: ${fix}`);
    } else {
      lines.push(`secrets: ${f} is readable by others: ${fix}`);
      ok = false;
    }
  }
  if (release !== null) {
    const shell = powershellPath(tools);
    if (!shell) {
      lines.push(`warning: wsl: ${POWERSHELL} is not on PATH, so Windows may sleep while missions run`);
    }
    if (wslSystemd) {
      const text = shell ? await readWslConfig(tools, shell) : null;
      const fix = "set vmIdleTimeout=-1 under [wsl2] in %UserProfile%\\.wslconfig, then run wsl --shutdown";
      if (text === null) {
        lines.push(`warning: wsl: .wslconfig could not be read, so no keep-alive is known: ${fix}`);
      } else if (!hasVmIdleTimeout(text)) {
        lines.push(`warning: wsl: no keep-alive, WSL may stop its VM and Towercab with it: ${fix}`);
      }
    }
  }
  if (o.quick) return { lines, ok };

  // PIP-163: the sandbox probe; PIP-162: the narrow fix where user namespaces are restricted.
  const bwrapPath = tools.which("bwrap");
  if (bwrapPath) {
    const version = await tools.run(bwrapPath, ["--version"]).catch(() => null);
    lines.push(`bwrap version: ${version?.stdout.trim() || "unknown"}`);
    const probe = await (o.probe ?? (() => sandboxProbe(tools)))();
    lines.push(`sandbox: ${probe.ok ? "the probe held" : `the probe failed: ${probe.why}`}`);
    if (!probe.ok) {
      ok = false;
      // PIP-162: the one owner step, only when the probe failed and the restriction is on without the profile,
      // or with Ubuntu's stock profile refusing the worker's shell.
      const step = profileStep((o.host ?? hostState)(), bwrapPath, probe);
      if (step)
        lines.push(`owner step: ${step.title}; run:`, ...step.commands.split("\n").map((l) => `  ${l}`));
      if (userNamespaceDenied(probe.why)) {
        lines.push(
          "sandbox: Ubuntu may restrict user namespaces; allow only this bwrap with this AppArmor profile:",
          ...apparmorProfile(bwrapPath).map((l) => `  ${l}`),
        );
      }
    }
  }

  const v = await ghVersion(tools);
  lines.push(`gh version: ${v.version}${v.ok ? "" : ": Towercab needs 2.46 or newer"}`);
  if (!v.ok) ok = false;
  const key = appKeyPath(config);
  if (!existsSync(key)) {
    lines.push(`github app: ${key} is missing (register the App from ops/github-app.json)`);
    ok = false;
  } else if ((statSync(key).mode & 0o077) !== 0) {
    // Reported with the other secrets files above; the App is not asked while its key is loose.
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
  // REPO-47: where each setting of a repo with an overlay comes from.
  for (const [name, repo] of config.repos) {
    const clone = clonePath(repo, home.root);
    const r = await overlayDoctor(tools, {
      configFile: config.file,
      name,
      clone,
      base: repo.base,
      slug: repo.github,
      cloned: existsSync(clone),
    });
    lines.push(...r.lines);
    if (!r.ok) ok = false;
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
  // REPO-19: a move PR that was closed is a warning, not a failure.
  if (o.db) {
    for (const name of config.repos.keys()) {
      if (readRecord(o.db, name, "move")?.state === "closed" && !isMoved(o.db, name)) {
        lines.push(
          `${name}: the PR that moves its settings into TOWERCAB.md was closed; open it again from the repo's page.`,
        );
      }
    }
  }
  for (const wh of config.notify.webhooks) {
    // LOOP-147: the file and the kind of URL, never the URL.
    const f = readTokenFile(wh.urlFile);
    const why = "why" in f ? `url_file ${wh.urlFile} ${f.why}` : urlProblem(f.token);
    lines.push(
      why ? `webhook ${wh.name}: ${why}` : `webhook ${wh.name}: ${wh.detail} messages, url in ${wh.urlFile}`,
    );
    if (why) ok = false;
  }
  lines.push(
    `telegram: ${config.telegram ? `chat ${config.telegram.chatId}${config.telegram.uiUrl ? `, links to ${config.telegram.uiUrl}` : ", links to the PR (no ui_url)"}` : "not configured (no messages)"}`,
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
