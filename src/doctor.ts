// `towercab doctor` (LOOP-15, LOOP-20): what is missing to run, one line each. `--quick` is the
// self-update check (LOOP-35): config, tools and modules only, no network.

import { existsSync, statSync } from "node:fs";
import type { Config } from "./config.ts";
import { appKeyPath, clonePath } from "./config.ts";
import type { GitHub } from "./handlers.ts";
import type { Home } from "./home.ts";
import type { Tools } from "./tools.ts";

export const TOOLS = ["git", "gh", "claude", "bwrap", "systemd-inhibit", "systemctl", "journalctl"];

export function ghVersionOk(text: string): { version: string; ok: boolean } {
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return { version: "unknown", ok: false };
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return { version: `${m[1]}.${m[2]}.${m[3]}`, ok: maj > 2 || (maj === 2 && min >= 46) };
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
  quick: boolean;
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
  if (o.quick) return { lines, ok };

  const gh = await tools.run("gh", ["--version"], { timeoutMs: 20_000 });
  const v = ghVersionOk(gh.stdout);
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
    const r = await o.github.owner(["auth", "status"], { timeoutMs: 20_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const me = config.github?.me ?? "";
    const logins = [...text.matchAll(/\b(?:account|as) ([\w-]+)/gi)].map((m) => m[1]!.toLowerCase());
    lines.push(
      me && logins.includes(me.toLowerCase())
        ? `gh login: ${me}`
        : `gh login: not logged in as ${me} (run gh auth login): the UI's actions need it`,
    );
  }
  for (const [name, repo] of config.repos) {
    lines.push(
      `${name}: ${repo.github} · ${existsSync(clonePath(repo, home.root)) ? "cloned" : "clones on first use"}`,
    );
  }
  for (const [name, why] of config.badRepos) lines.push(`${name}: ${why}`);
  // LOOP-65: a table for a repo in the database is ignored; it can go.
  for (const [name, why] of config.ignoredRepos) lines.push(`${name}: ${why}`);
  lines.push(
    `telegram: ${config.telegram ? `chat ${config.telegram.chatId}` : "not configured (no messages)"}`,
  );
  return { lines, ok };
}
