// Drafting a verifying section (REPO-34, REPO-35): from package scripts, a Makefile, CI, or plain files.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  checksSomething,
  commandIsCheckOnly,
  type DraftInput,
  draftPrBody,
  draftVerifying,
  insertVerifying,
} from "../../src/repo/draft.ts";
import { parseVerifying } from "../../src/repo/files.ts";

const has = { python3: true, node: true };

function input(paths: string[], texts: Record<string, string> = {}, tests?: string[]): DraftInput {
  return { paths, texts, has, ...(tests ? { tests } : {}) };
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });

test("repo: draft from package scripts", () => {
  const [d] = draftVerifying(
    input(["package.json", "package-lock.json"], {
      "package.json": pkg({ lint: "biome check", test: "vitest run", start: "node ." }),
    }),
  );
  expect(d!.source).toBe("package.json scripts");
  expect(d!.setup).toEqual(["npm ci"]);
  expect(d!.checks).toEqual(["npm run lint", "npm test"]);
  expect(d!.evidence.map((e) => e.from)).toContain('the "lint" script in package.json');
  // A `check` script stands for the lot; pnpm's lockfile picks pnpm.
  const [c] = draftVerifying(
    input(["package.json", "pnpm-lock.yaml"], { "package.json": pkg({ check: "x", test: "y" }) }),
  );
  expect(c!.setup).toEqual(["pnpm install --frozen-lockfile"]);
  expect(c!.checks[0]).toBe("pnpm run check");
  // npm's placeholder test script is not a check.
  const none = draftVerifying(
    input(["package.json"], { "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }) }),
  );
  expect(none.find((x) => x.source === "package.json scripts")).toBeUndefined();
});

test("repo: draft from a Makefile", () => {
  const [d] = draftVerifying(input(["Makefile"], { Makefile: "build:\n\tcc x.c\n\ncheck: build\n\t./x\n" }));
  expect(d!.source).toBe("Makefile");
  expect(d!.checks[0]).toBe("make check");
  const t = draftVerifying(input(["Makefile"], { Makefile: "test:\n\t./t\n" }));
  expect(t[0]!.checks[0]).toBe("make test");
});

test("repo: draft from CI workflows", () => {
  const wf = [
    "on: [pull_request]",
    "jobs:",
    "  t:",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: npm ci",
    "      - run: npm run lint",
    "      - run: |",
    "          npm test",
    "          curl -X POST https://example.com/hook",
    "",
  ].join("\n");
  const [d] = draftVerifying(input([".github/workflows/ci.yml"], { ".github/workflows/ci.yml": wf }));
  expect(d!.source).toBe("the CI workflows");
  expect(d!.setup).toEqual(["npm ci"]);
  expect(d!.checks).toEqual(["npm run lint", "npm test"]);
  expect(d!.notCovered.join(" ")).toMatch(/left out/);
  // A workflow that only runs on a push is not read.
  const push = "on: [push]\njobs:\n  t:\n    steps:\n      - run: npm test\n";
  expect(draftVerifying(input([".github/workflows/p.yml"], { ".github/workflows/p.yml": push }))).toEqual([]);
});

const STATIC = ["index.html", "feed.ics", "data/cities.json"];

test("repo: draft for a static site validates its files", () => {
  const [d] = draftVerifying(input(STATIC));
  expect(d!.source).toBe("the repo's plain files");
  expect(d!.setup).toEqual([]);
  // Inline commands only: no script file is named, nothing is added to the repo.
  expect(d!.checks.some((l) => l.includes("HTMLParser"))).toBe(true);
  expect(d!.checks.some((l) => l.includes("VCALENDAR"))).toBe(true);
  expect(d!.checks.some((l) => l.includes("json.load"))).toBe(true);
  expect(d!.checks.join("\n")).not.toMatch(/scripts\/|\.sh\b|\.py\b/);
  expect(d!.checks.every((l) => commandIsCheckOnly(l))).toBe(true);
  // A format with no inline checker is left out and said so.
  const [y] = draftVerifying(input([...STATIC, "config.yaml"]));
  expect(y!.notCovered.join(" ")).toMatch(/\.yaml files/);
  // Without Python the HTML cannot be parsed: said, not guessed.
  const [n] = draftVerifying({ paths: STATIC, texts: {}, has: { python3: false, node: true } });
  expect(n!.checks.some((l) => l.includes("HTMLParser"))).toBe(false);
  expect(n!.notCovered.join(" ")).toMatch(/HTML pages/);
});

test("repo: draft never takes deploy or secret commands", () => {
  for (const line of [
    "npm publish",
    "curl https://x.example/a",
    "make deploy",
    "./deploy.sh",
    "echo ${{ secrets.TOKEN }}",
    "docker push img",
    "aws s3 sync . s3://b",
    "git push origin main",
    "npm ci",
  ]) {
    expect(commandIsCheckOnly(line), line).toBe(false);
  }
  expect(commandIsCheckOnly("npm ci", "setup")).toBe(true);
  expect(commandIsCheckOnly("npm run lint")).toBe(true);
  // A script that deploys is not taken from package.json either.
  const d = draftVerifying(
    input(["package.json"], { "package.json": pkg({ test: "vitest", lint: "deploy --dry" }) }),
  );
  expect(d[0]!.checks.join(" ")).not.toMatch(/lint/);
});

test("repo: draft runs the test folder", () => {
  const [js] = draftVerifying(input([...STATIC, "tests/feed.test.js"]));
  expect(js!.checks.at(-1)).toBe("node --test tests/");
  const [py] = draftVerifying(input([...STATIC, "test/test_feed.py"]));
  expect(py!.checks.at(-1)).toBe("python3 -m unittest discover -s test");
  // A repo's own tool runs its tests: nothing extra.
  const [n] = draftVerifying(
    input(["package.json", "tests/a.test.ts"], { "package.json": pkg({ test: "vitest run" }) }),
  );
  expect(n!.checks).toEqual(["npm test"]);
  // The owner's globs say where the tests are.
  const [g] = draftVerifying(input([...STATIC, "spec/a.spec.js"], {}, ["spec/**"]));
  expect(g!.checks.at(-1)).toBe("node --test spec/");
});

test("repo: draft runs a test folder added later", () => {
  const [d] = draftVerifying(input(STATIC));
  // No folder yet: a guarded line that passes while it is empty or absent, and runs a test once it is there.
  expect(d!.checks.at(-1)).toBe("[ ! -d tests ] || node --test tests/");
  expect(checksSomething(d!)).toBe(true);
  const [p] = draftVerifying(input(["package.json"], { "package.json": pkg({ lint: "x" }) }));
  expect(p!.checks.at(-1)).toBe("[ ! -d tests ] || node --test tests/");
  // The guarded line alone is not a check (REPO-35).
  expect(checksSomething({ ...d!, substantive: [] })).toBe(false);
});

test("repo: a draft is written into CLAUDE.md and reads back", () => {
  const [d] = draftVerifying(input(STATIC));
  const created = insertVerifying(null, d!, "site");
  const v = parseVerifying(created);
  expect(v.checks).toEqual(d!.checks);
  // Existing text stays byte-identical.
  const old = "# Site\n\nSome notes.\n";
  const added = insertVerifying(old, d!, "site");
  expect(added.startsWith(old)).toBe(true);
  expect(parseVerifying(added).checks).toEqual(d!.checks);
  const heading = "# Site\n\n## Verifying your work\n\nRun it by hand.\n";
  const under = insertVerifying(heading, d!, "site");
  expect(under).toContain("Run it by hand.");
  expect(parseVerifying(under).checks).toEqual(d!.checks);
  const body = draftPrBody(d!, { base: "main", created: true, output: "ok" });
  expect(body).toMatch(/^## What this does/);
  expect(body).toContain("## What to check before merging");
});

const python = spawnSync("python3", ["--version"]).status === 0;

test.skipIf(!python)("repo: the static checks pass on good files and fail on broken ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "draft-"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "index.html"), "<html><body><div><p>hi<br></div></body></html>");
  writeFileSync(join(dir, "feed.ics"), "BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VEVENT\nEND:VCALENDAR\n");
  writeFileSync(join(dir, "data/cities.json"), '{"a":1}');
  const [d] = draftVerifying(input([...STATIC, "data.csv"]));
  writeFileSync(join(dir, "data.csv"), "a,b\n1,2\n");
  const run = () => spawnSync("sh", ["-c", d!.checks.join(" && ")], { cwd: dir, encoding: "utf8" });
  expect(run().status).toBe(0);
  writeFileSync(join(dir, "index.html"), "<html><body><div><span></div></body></html>");
  expect(run().status).not.toBe(0);
  writeFileSync(join(dir, "index.html"), "<html><body></body></html>");
  writeFileSync(join(dir, "feed.ics"), "BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VCALENDAR\n");
  expect(run().status).not.toBe(0);
});
