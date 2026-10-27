// What the public repo shows (PUB-1..6) and Towercab's own CI (PIP-12).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

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
  expect(readme).not.toMatch(/<img|!\[/);
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

test("public: CI workflow runs the checks", () => {
  const ci = read(".github/workflows/ci.yml");
  expect(ci).toMatch(/name: "Node 22: lint, typecheck, tests"/);
  expect(ci).toMatch(/npm run check/);
  expect(ci).toMatch(/name: "Playwright: UI screenshots"/);
  expect(ci).toMatch(/npm run test:ui/);
  expect(ci).toMatch(/upload-artifact/);
  for (const job of ci.split("\n  ").filter((l) => /^[a-z-]+:\n/.test(l))) expect(job).toMatch(/name: /);
});
