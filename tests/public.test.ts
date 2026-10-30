// What the public repo shows (PUB-1..8, PUB-13..17) and Towercab's own CI (PIP-12).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";

const read = (p: string) => readFileSync(p, "utf8");

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
  expect(license.split("\n")[0]).toBe("MIT License");
  expect(license).toMatch(/Copyright \(c\) \d{4} \S/);
  expect(JSON.parse(read("package.json")).license).toBe("MIT");
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
});

test("public: README says not affiliated", () => {
  const readme = read("README.md");
  expect(readme).toMatch(/not affiliated with or\s+endorsed by Anthropic/);
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
  for (const job of ci.split("\n  ").filter((l) => /^[a-z-]+:\n/.test(l))) expect(job).toMatch(/name: /);
});
