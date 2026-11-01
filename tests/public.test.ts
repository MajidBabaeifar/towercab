// What the public repo shows (PUB-1..8, PUB-13..21), Towercab's own CI (PIP-12, PIP-90) and its releases (PIP-91).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "../src/config.ts";

const read = (p: string) => readFileSync(p, "utf8");
// biome-ignore lint/suspicious/noExplicitAny: workflow files are checked by shape, not typed
const workflow = (p: string): any => parseYaml(read(p));
type Job = { name?: string; permissions?: object; uses?: string; steps?: { uses?: string }[] };

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "node_modules" || f === "dist" || f === "screenshots") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("public: license and security policy", () => {
  const license = read("LICENSE");
  expect(license.trim().split("\n")[0]!.trim()).toBe("GNU AFFERO GENERAL PUBLIC LICENSE");
  expect(license).toMatch(/Version 3, 19 November 2007/);
  expect(JSON.parse(read("package.json")).license).toBe("AGPL-3.0-only");
  const readme = read("README.md");
  expect(readme).toMatch(/badge\/license-AGPL--3\.0--only-/);
  expect(readme).toMatch(/Copyright \(c\) \d{4} \S.*AGPL-3\.0-only/);
  const security = read("SECURITY.md");
  expect(security).toMatch(/Report a vulnerability/);
  expect(security).toMatch(/not open a public issue/);
  expect(security).toMatch(/latest release|`main`/);
});

test("public: README sections", () => {
  const readme = read("README.md");
  const sections = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim().toLowerCase());
  expect(sections).toEqual([
    "what it is",
    "how it works",
    "requirements",
    "quickstart",
    "safety",
    "status",
    "docs",
  ]);
  const cli = read("src/cli.ts");
  const quick = readme.split("## Quickstart")[1]!.split("## Safety")[0]!;
  for (const m of quick.matchAll(/towercab (\w+)/g)) {
    expect(cli, `towercab ${m[1]} is a command`).toContain(`"${m[1]}"`);
  }
  expect(readme).toMatch(/Node\.js 22\.18/);
  expect(readme).toContain("From intent to production.");
  const how = readme.split("## How it works")[1]!.split("## Requirements")[0]!;
  expect(how).toContain("](specs/pipeline.md)");
  expect(how).toContain("](specs/ship.md)");
  expect(how).toMatch(/rollback/i);
});

test("public: README says not affiliated", () => {
  const readme = read("README.md");
  expect(readme).toMatch(/not affiliated with or\s+endorsed by Anthropic/);
  const header = readme.split("## What it is")[0]!;
  expect(header).toContain("Inspired by Anthropic's AI-Native SDLC Playbook.");
  expect(header).toMatch(/Not affiliated with or endorsed by Anthropic/);
  const images = [
    ...readme.matchAll(/<img[^>]*\ssrc="([^"]+)"|<source[^>]*\ssrcset="([^"]+)"|!\[[^\]]*\]\(([^)]+)\)/g),
  ];
  expect(images.length).toBeGreaterThan(0);
  for (const m of images) {
    const src = (m[1] ?? m[2] ?? m[3])!;
    expect(src).toMatch(
      /^(ui\/public\/favicon\.svg|docs\/assets\/[a-z-]+\.png|https:\/\/img\.shields\.io\/|https:\/\/github\.com\/MajidBabaeifar\/towercab\/actions\/)/,
    );
    if (!src.startsWith("https:")) expect(existsSync(src), src).toBe(true);
  }
});

test("public: README shows the screenshot and website", () => {
  const readme = read("README.md");
  const top = readme.split("## How it works")[0]!;
  expect(top).toMatch(/<img src="docs\/assets\/overview-light\.png" alt="[^"]{10,}"/);
  expect(top).toMatch(/srcset="docs\/assets\/overview-dark\.png"/);
  for (const f of ["overview-light", "overview-dark"]) expect(existsSync(`docs/assets/${f}.png`)).toBe(true);
  const first = readme.split("## What it is")[1]!.split("## How it works")[0]!;
  expect(first).toContain("https://towercab.com");
});

test("public: contributing guide", () => {
  const guide = read("CONTRIBUTING.md");
  expect(guide).toMatch(/\]\(specs\/README\.md\)/);
  expect(guide).toContain("npm ci");
  expect(guide).toContain("npm run check");
  expect(guide).toContain("Conventional Commits");
  expect(guide).toMatch(/small/i);
  expect(guide).toMatch(/hermetic/i);
  expect(guide).toMatch(/\]\(SECURITY\.md\)/);
  expect(guide).toMatch(/not (in )?(an )?(public )?issue|not .*issues?/i);
  expect(read("README.md")).toMatch(/\]\(CONTRIBUTING\.md\)/);
  expect(guide).toMatch(/Affero General Public License v3\.0 only/);
  expect(guide).toMatch(
    /grant\s+the project owner .* license to use, change and\s+distribute it under other terms/s,
  );
});

test("public: code of conduct", () => {
  const coc = read("CODE_OF_CONDUCT.md");
  expect(coc).toContain("Contributor Covenant");
  expect(coc).toContain("version 2.1");
  const enforcement = coc.split("\n## Enforcement\n")[1]!.split("\n## ")[0]!;
  expect(enforcement).toMatch(/private(ly)? report/i);
  expect(enforcement).toContain("Security");
  expect(coc).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  expect(coc).not.toContain("[INSERT");
  expect(`${read("README.md")}\n${read("CONTRIBUTING.md")}`).toMatch(/\]\(CODE_OF_CONDUCT\.md\)/);
});

test("public: example config", () => {
  const text = read("config.example.toml");
  const raw = parseToml(text) as Record<string, Record<string, unknown>>;
  const config = parseConfig(raw, "config.example.toml");
  expect([...config.badRepos]).toEqual([]);
  expect(config.repos.has("web")).toBe(true);
  const keys = {
    intents: ["remote", "path", "cutoff", "issue_a"],
    agent: [
      "model",
      "review_model",
      "parallel",
      "build_timeout",
      "review_timeout",
      "check_timeout",
      "max_budget_usd",
      "daily_budget_usd",
      "ci_poll",
      "ci_grace",
      "ci_wait",
      "path",
      "toolchain",
      "env",
      "network",
      "sandbox_unix_sockets",
    ],
    github: ["app_id", "me", "api_base"],
    telegram: ["bot_token", "chat_id", "api_base"],
    ui: ["port"],
    update: ["auto"],
  };
  for (const [table, list] of Object.entries(keys)) {
    expect(Object.keys(raw[table] ?? {}).sort(), table).toEqual([...list].sort());
  }
  const repos = raw.repos as unknown as Record<string, Record<string, unknown>>;
  expect(Object.keys(repos.web!).sort()).toEqual(["ahead", "base", "env", "github", "path", "workers"]);
  // Each setting has a one-line comment above it; the file holds placeholders only.
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/^[A-Za-z_]+ = /.test(line)) expect(lines[i - 1] ?? "", line).toMatch(/^# \S/);
  });
  expect(text).not.toMatch(/\/home\/|\/Users\/|majid/i);
  expect(text).not.toMatch(/-----BEGIN|ghp_|github_pat_|\d{8,}:[A-Za-z0-9_-]{30,}/);
  expect(config.github?.me).toBe("your-login");
  const quick = read("README.md").split("## Quickstart")[1]!.split("## Safety")[0]!;
  expect(quick).toContain("config.example.toml");
});

test("public: README docs index", () => {
  const readme = read("README.md");
  const docs = readme.split("## Docs")[1]!;
  const linked = [...docs.matchAll(/\]\((specs\/[^)]+)\)/g)].map((m) => m[1]!);
  const index = read("specs/README.md");
  const removed = new Set(
    [...index.matchAll(/^\| \[([a-z]+\.md)\]\([^)]+\) \| [A-Z]+ \| Removed/gm)].map((m) => `specs/${m[1]}`),
  );
  const want = readdirSync("specs")
    .filter((f) => f.endsWith(".md") && !f.startsWith("_") && f !== "README.md")
    .map((f) => `specs/${f}`)
    .filter((f) => !removed.has(f));
  expect(new Set(linked)).toEqual(new Set([...want, "specs/README.md"]));
  for (const m of readme.matchAll(/\]\(((?!https?:)[^)#]+)\)/g)) expect(existsSync(m[1]!), m[1]).toBe(true);
});

test("public: no personal names", () => {
  const name = "Majid";
  const files = [
    "README.md",
    "package.json",
    "CLAUDE.md",
    "TOWERCAB.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "config.example.toml",
    ...walk("docs").filter((f) => [".md", ".txt", ".svg", ".toml"].includes(extname(f))),
    ...walk("agents"),
    ...walk("prompts"),
    ...walk("skills"),
    ...walk("src"),
    ...walk("ui/src"),
    ...walk("ops"),
    ...walk("specs"),
  ];
  const hits = files.filter((f) =>
    new RegExp(`\\b${name}\\b`).test(read(f).replaceAll(`github.com/${name}Babaeifar`, "")),
  );
  expect(hits).toEqual([]);
});

test("public: the App manifest stays private", () => {
  const manifest = JSON.parse(read("ops/github-app.json"));
  expect(manifest.public).toBe(false);
  const src = walk("src").map(read).join("\n");
  expect(src).not.toMatch(/gh repo edit|\/repos\/[^"`]*\/(topics|visibility)/);
});

test("public: gitleaks allowlist is by fingerprint", () => {
  const toml = read(".gitleaks.toml");
  expect(toml).toMatch(/useDefault\s*=\s*true/);
  expect(toml).not.toMatch(/^\s*(paths|regexes|stopwords|rules|commits)\s*=/m);
  const lines = read(".gitleaksignore").split("\n");
  lines.forEach((line, i) => {
    if (line.trim() === "" || line.startsWith("#")) return;
    expect(line).toMatch(/^[0-9a-f]{40}:[^:]+:[^:]+:\d+$/);
    expect(lines[i - 1] ?? "").toMatch(/^#\s*\S/);
  });
});

test("public: CI workflow runs the checks", () => {
  const ci = read(".github/workflows/ci.yml");
  expect(ci).toMatch(/name: "Node 22: lint, typecheck, tests"/);
  expect(ci).toMatch(/npm run check/);
  expect(ci).toMatch(/name: "Playwright: UI screenshots"/);
  expect(ci).toMatch(/npm run test:ui/);
  expect(ci).toMatch(/upload-artifact/);
  const jobs: Record<string, Job> = workflow(".github/workflows/ci.yml").jobs;
  for (const [id, job] of Object.entries(jobs)) expect(job.name, `job ${id} sets name`).toBeTruthy();
});

test("public: CI workflow has one required aggregate job", () => {
  const ci = workflow(".github/workflows/ci.yml");
  expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
  expect(ci.on.push.branches).toEqual(["main"]);
  expect(ci.jobs.checks.uses).toBe("./.github/workflows/checks.yml");
  expect(ci.jobs.sast.uses).toBe("./.github/workflows/sast.yml");
  const ok = ci.jobs["ci-ok"];
  expect(ok.name).toBe("All required checks passed");
  expect(ok.if).toBe("always()");
  const others = Object.keys(ci.jobs).filter((id) => id !== "ci-ok");
  expect([...ok.needs].sort()).toEqual(others.sort());
  const script = ok.steps.map((s: { run?: string }) => s.run ?? "").join("\n");
  expect(script).toMatch(/success\|skipped/);
  expect(script).toMatch(/exit 1/);
});

test("public: CI workflow pins actions by SHA and grants permissions per job", () => {
  for (const file of [".github/workflows/ci.yml", ".github/workflows/release-please.yml"]) {
    const wf = workflow(file);
    expect(wf.permissions, `${file} top-level permissions`).toEqual({});
    for (const [id, job] of Object.entries(wf.jobs as Record<string, Job>)) {
      expect(job.permissions, `${file} job ${id} permissions`).toBeDefined();
      const uses = [job.uses, ...(job.steps ?? []).map((s: { uses?: string }) => s.uses)].filter(
        (u): u is string => typeof u === "string",
      );
      for (const u of uses) {
        if (u.startsWith("./.github/workflows/")) continue;
        expect(u, `${file} job ${id}`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  }
});

test("public: release-please files are present and consistent", () => {
  const config = JSON.parse(read("release-please-config.json"));
  expect(config.packages["."]["release-type"]).toBe("node");
  const manifest = JSON.parse(read(".release-please-manifest.json"));
  expect(manifest["."]).toBe(JSON.parse(read("package.json")).version);
  const release = workflow(".github/workflows/release-please.yml");
  expect(release.on.push.branches).toEqual(["main"]);
  expect(release.jobs.release.uses).toBe("./.github/workflows/release.yml");
});

test("public: CI calls synced copies of the shared workflows", () => {
  const callers = [".github/workflows/ci.yml", ".github/workflows/release-please.yml"];
  const called = new Set<string>();
  for (const file of callers) {
    const text = read(file);
    expect(text, `${file} calls no private workflow`).not.toMatch(/uses: MajidBabaeifar\/ci\//);
    for (const job of Object.values(workflow(file).jobs as Record<string, Job>)) {
      if (job.uses?.startsWith("./")) called.add(job.uses.slice(2));
    }
  }
  expect([...called].sort()).toEqual([
    ".github/workflows/checks.yml",
    ".github/workflows/release.yml",
    ".github/workflows/sast.yml",
  ]);
  for (const path of called) {
    const first = read(path).split("\n")[0]!;
    expect(first).toMatch(
      new RegExp(
        `^# Synced from MajidBabaeifar/ci@[0-9a-f]{12} ${path.replace(/\./g, "\\.")}; edit there, not here\\.$`,
      ),
    );
    expect(workflow(path).on).toHaveProperty("workflow_call");
  }
});

test("public: renovate extends the org config", () => {
  expect(JSON.parse(read("renovate.json"))).toEqual({ extends: ["github>MajidBabaeifar/ci"] });
});

type FormItem = {
  type: string;
  attributes?: { label?: string; description?: string; render?: string };
  validations?: { required?: boolean };
};

function form(file: string): { labels?: unknown; body: FormItem[]; name: string; description: string } {
  const f = parseYaml(read(`.github/ISSUE_TEMPLATE/${file}`));
  expect(f.name).toBeTruthy();
  expect(f.description).toBeTruthy();
  for (const item of f.body as FormItem[]) {
    expect(item.type).toBeTruthy();
    if (item.type === "input" || item.type === "textarea") expect(item.attributes?.label).toBeTruthy();
    if (item.validations) expect(typeof item.validations.required).toBe("boolean");
  }
  expect(JSON.stringify(f.labels ?? [])).not.toMatch(/towercab/i);
  return f;
}

const field = (items: FormItem[], re: RegExp) => items.find((i) => re.test(i.attributes?.label ?? ""));

test("public: bug report form asks for the versions and logs", () => {
  const { body } = form("bug_report.yml");
  for (const re of [
    /what happened/i,
    /expected/i,
    /towercab.*(commit|version)/i,
    /^OS/i,
    /node/i,
    /\bgh\b/i,
    /claude code/i,
  ]) {
    const item = field(body, re);
    expect(item, String(re)).toBeDefined();
    expect(item?.validations?.required, String(re)).toBe(true);
  }
  const logs = field(body, /log/i);
  expect(logs?.type).toBe("textarea");
  expect(logs?.validations?.required).not.toBe(true);
  expect(logs?.attributes?.render).toBe("shell");
  expect(logs?.attributes?.description).toMatch(/remove[^.]*(secret|token)/i);
});

test("public: feature request form has problem and outcome", () => {
  const { body } = form("feature_request.yml");
  for (const label of ["Problem", "Proposed outcome"]) {
    const item = body.find((i) => i.attributes?.label === label);
    expect(item?.type, label).toBe("textarea");
    expect(item?.validations?.required, label).toBe(true);
  }
});

test("public: issue chooser blocks blank issues and points to the security policy", () => {
  const c = parseYaml(read(".github/ISSUE_TEMPLATE/config.yml"));
  expect(c.blank_issues_enabled).toBe(false);
  expect(c.contact_links).toHaveLength(1);
  expect(c.contact_links[0].name).toMatch(/vulnerab/i);
  expect(c.contact_links[0].url).toMatch(/\/SECURITY\.md$/);
  expect(existsSync("SECURITY.md")).toBe(true);
});

test("public: pull request template sections", () => {
  const t = read(".github/pull_request_template.md");
  const heads = [...t.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.toLowerCase());
  expect(heads).toHaveLength(4);
  expect(heads[0]).toMatch(/what.*why/);
  expect(heads[1]).toMatch(/spec/);
  expect(heads[2]).toMatch(/checked/);
  expect(heads[3]).toMatch(/screenshot/);
  expect(t).toContain("npm run check");
});
