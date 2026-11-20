// A rig for the settings tests: the readiness rig (local bare repos for `web` and `ci`, a fake `gh`) plus a
// fake `bin/apply-settings` and a fake GitHub API for the guard, the backup and the restore. Never the network.

import { join } from "node:path";
import { ensureClone } from "../../src/checkout.ts";
import { clonePath, type RepoConfig } from "../../src/config.ts";
import { applySettings, settingsPass } from "../../src/settings/apply.ts";
import type { SettingsDeps } from "../../src/settings/script.ts";
import { type Rig, release, rig, WEB } from "../helpers/ready.ts";
import { failResult, okResult, type RunFn } from "../helpers/tools.ts";

// biome-ignore lint/suspicious/noExplicitAny: GitHub's JSON, read field by field
export type Json = Record<string, any>;

/** What the fake GitHub holds and what was written to it. */
export interface Gh {
  towercab: string | null;
  /** The check runs on main's head, `[name, conclusion]`. */
  runs: [string, string][];
  repo: Json;
  rulesets: Json[];
  protection: Json | null;
  workflow: Json;
  alerts: boolean;
  /** `METHOD path` of every write. */
  writes: string[];
  bodies: Record<string, unknown>;
}

export function newGh(): Gh {
  return {
    towercab: null,
    runs: [["ci-ok", "success"]],
    repo: {
      default_branch: "main",
      allow_squash_merge: true,
      allow_merge_commit: false,
      delete_branch_on_merge: false,
      security_and_analysis: { secret_scanning: { status: "enabled" } },
    },
    rulesets: [
      { id: 1, name: "main rules", target: "branch", enforcement: "active", conditions: {}, rules: [] },
    ],
    protection: {
      required_status_checks: { strict: true, contexts: ["ci-ok"] },
      enforce_admins: { enabled: true },
    },
    workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    alerts: true,
    writes: [],
    bodies: {},
  };
}

const notFound = () => failResult("gh: Not Found (HTTP 404)");

/** `gh` as the repo API answers it. */
export function ghHandler(g: Gh, slug = "owner/web"): RunFn {
  const root = `repos/${slug}`;
  return (args, opts) => {
    if (args[0] !== "api") return failResult(`gh ${args.join(" ")}: not faked`);
    const path = args[1]!;
    const x = args.indexOf("-X");
    const method = x >= 0 ? args[x + 1]! : "GET";
    if (method !== "GET") {
      g.writes.push(`${method} ${path}`);
      g.bodies[`${method} ${path}`] = opts.input ? JSON.parse(opts.input) : undefined;
      return okResult();
    }
    if (path.startsWith(`${root}/contents/TOWERCAB.md`))
      return g.towercab === null ? notFound() : okResult(g.towercab);
    if (path === `${root}/commits/main`) return okResult("abc123\n");
    if (path.startsWith(`${root}/commits/abc123/check-runs`)) {
      return okResult(g.runs.map(([n, c]) => `${n}\t${c}`).join("\n"));
    }
    if (path === root) return okResult(JSON.stringify(g.repo));
    if (path === `${root}/rulesets`)
      return okResult(JSON.stringify(g.rulesets.map((r) => ({ id: r.id, name: r.name }))));
    const rs = /\/rulesets\/(\d+)$/.exec(path);
    if (rs) {
      const r = g.rulesets.find((r) => String(r.id) === rs[1]);
      return r ? okResult(JSON.stringify(r)) : notFound();
    }
    if (path === `${root}/branches/main/protection`)
      return g.protection ? okResult(JSON.stringify(g.protection)) : notFound();
    if (path === `${root}/actions/permissions/workflow`) return okResult(JSON.stringify(g.workflow));
    if (path === `${root}/vulnerability-alerts`) return g.alerts ? okResult() : notFound();
    return failResult(`gh api ${path}: not faked`);
  };
}

/** A fake settings script: the gap lines it reports until an apply that fixes them. */
export interface Script {
  gaps: string[];
  /** The plan's JSON, or null for a release without `--plan`. */
  plan: string | null;
  /** Releases without `--skip-ruleset` fail with a usage error. */
  skipRuleset: boolean;
  /** An apply answers 403. */
  forbidden: boolean;
  /** The argument lists it was run with. */
  runs: string[][];
  /** A gap only a whole apply clears (not `--skip-ruleset`). */
  rulesetGap: string | null;
}

export function newScript(gaps: string[] = ["merge rules are off"]): Script {
  return {
    gaps,
    plan: JSON.stringify({ rulesets: [{ required_status_checks: ["ci-ok"] }], branches: [] }),
    skipRuleset: true,
    forbidden: false,
    runs: [],
    rulesetGap: null,
  };
}

export function scriptHandler(s: Script): RunFn {
  return (args) => {
    s.runs.push(args);
    if (args[0] === "--check") {
      const all = [...s.gaps, ...(s.rulesetGap ? [s.rulesetGap] : [])];
      return all.length
        ? { code: 1, stdout: `${all.join("\n")}\n`, stderr: "", timedOut: false }
        : okResult();
    }
    if (args[0] === "--plan")
      return s.plan === null
        ? { code: 2, stdout: "", stderr: "usage: --plan unknown\n", timedOut: false }
        : okResult(s.plan);
    if (s.forbidden) return failResult("gh: Resource not accessible by integration (HTTP 403)");
    if (args[0] === "--skip-ruleset") {
      if (!s.skipRuleset) return failResult("usage: unknown option --skip-ruleset", 2);
      s.gaps = [];
      return okResult();
    }
    s.gaps = [];
    s.rulesetGap = null;
    return okResult();
  };
}

export interface SettingsRig {
  r: Rig;
  deps: SettingsDeps;
  gh: Gh;
  script: Script;
  logs: string[];
  web: RepoConfig;
}

/** `web` and `ci` (tagged on its main, with the script), `gh` and the script faked. */
export async function settingsRig(o: { tags?: string[] } = {}): Promise<SettingsRig> {
  const r = rig({ web: WEB, ci: { "README.md": "ci\n" } });
  const tags = o.tags ?? ["v1.0.0"];
  for (const tag of tags) release(r.remotes.ci!, { "bin/apply-settings": `#!/bin/sh\n# ${tag}\n` }, tag);
  const gh = newGh();
  const script = newScript();
  r.tools.on("gh", ghHandler(gh));
  for (const tag of tags) {
    r.tools.on(join(r.home, "tmp", `ci-apply-${tag}`, "bin", "apply-settings"), scriptHandler(script));
  }
  const ci = r.config.repos.get("ci")!;
  await ensureClone(r.tools, clonePath(ci, r.home), ci);
  const logs: string[] = [];
  const deps: SettingsDeps = { ...r.deps, log: (l) => logs.push(l) };
  return { r, deps, gh, script, logs, web: r.config.repos.get("web")! };
}

/** The daily check, then the owner's Apply: what a click on a repo with gaps does. */
export async function checkThenApply(s: SettingsRig) {
  await settingsPass(s.deps, s.web);
  return applySettings(s.deps, s.web);
}
