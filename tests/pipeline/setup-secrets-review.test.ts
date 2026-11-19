// Review fixes for the setup secrets (PIP-212, PIP-214): the owner's answer is used, a link in a parent folder
// stops the copy, and branch code never writes the cache the secret pass reads.

import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { copyOut, exportTree } from "../../src/pipeline/setup-pass.ts";
import { build, CLAUDE_MD, CODE, happy, ID, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { FakeTools } from "../helpers/tools.ts";
import { git, tempDir } from "../helpers/world.ts";

test("pipeline: a link in a parent folder stops the copy outside the checkout", async () => {
  const dir = join(tempDir(), "co");
  mkdirSync(join(dir, "packages", "a"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(dir, "packages", "a", "x.txt"), "x");
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD").trim();
  const tree = `${dir}-setup-tree`;
  mkdirSync(tree);
  const tools = new FakeTools();
  await exportTree(tools, dir, base, tree);
  mkdirSync(join(tree, "packages", "a", "node_modules"), { recursive: true });
  writeFileSync(join(tree, "packages", "a", "node_modules", "p.txt"), "new");
  mkdirSync(join(tree, "node_modules"), { recursive: true });
  writeFileSync(join(tree, "node_modules", "ok.txt"), "ok");
  // The worker swapped `packages/a` for a link to a folder outside the checkout.
  const outside = tempDir();
  mkdirSync(join(outside, "node_modules"));
  writeFileSync(join(outside, "node_modules", "mine.txt"), "mine");
  git(dir, "rm", "-rq", "--cached", "packages");
  mkdirSync(join(dir, "x"), { recursive: true });
  await import("node:fs").then((fs) => fs.rmSync(join(dir, "packages", "a"), { recursive: true }));
  symlinkSync(outside, join(dir, "packages", "a"));
  await copyOut(tools, dir, tree);
  expect(readFileSync(join(outside, "node_modules", "mine.txt"), "utf8")).toBe("mine");
  expect(existsSync(join(outside, "node_modules", "p.txt"))).toBe(false);
  // A plain path still copies.
  expect(readFileSync(join(dir, "node_modules", "ok.txt"), "utf8")).toBe("ok");
});

const INSTALL = 'echo "registry token:${NPM_TOKEN:-none}"\n';
const BRANCH = { ...CODE, "package.json": '{"name":"web","version":"2"}\n' };
const TOKEN = "tok_Secr3tValue_9f8e7d6c";

function world(): Pipe {
  const p = new Pipe(
    {
      ...TARGET,
      "CLAUDE.md": CLAUDE_MD.replace(
        "## Verifying your work\n",
        "## Verifying your work\n\n```setup\nsh ci/install.sh\n```\n",
      ),
      "package.json": '{"name":"web"}\n',
      "ci/install.sh": INSTALL,
    },
    intents(intent({ a: 5 })),
    { keep: true },
  );
  happy(p);
  p.respond.worker = reply(build(), BRANCH);
  const path = join(p.home.root, "setup-secrets", "web.env");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `NPM_TOKEN=${TOKEN}\n`);
  chmodSync(path, 0o600);
  return p;
}

let p: Pipe;

beforeAll(async () => {
  p = world();
  p.sandbox = (spec) => {
    if (!spec.stdout.endsWith("-setup-open.log")) return null;
    writeFileSync(spec.stdout, "$ sh ci/install.sh\n");
    writeFileSync(
      spec.stderr,
      "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://npm.corp.example/@corp%2fw\n",
    );
    return { code: 1, signal: null };
  };
  await p.start();
  await p.until(() => p.mission()?.waiting === "answer the question", 80);
}, 60_000);

afterAll(() => p.cleanup());

test("pipeline: branch code never writes the cache the secret pass reads", () => {
  const cache = p.home.cache("web");
  const runs = p.sandboxRuns;
  const second = runs.find((r) => r.argv.some((a) => a.endsWith("-setup-cache")))!;
  expect(second.kind).toBe("setup");
  expect(second.argv).not.toContain(cache);
  const own = second.argv.find((a) => a.endsWith("-setup-cache"))!;
  expect(second.argv[second.argv.indexOf(own) - 1]).toBe("--bind");
  expect(existsSync(own)).toBe(false);
  for (const r of runs.filter((r) => r.kind === "checks" || r.kind === "shots")) {
    expect(r.argv[r.argv.indexOf(cache) - 1]).toBe("--ro-bind");
  }
  expect(ID).toBeTruthy();
});

test("pipeline: choosing public packages sends the answer to the worker", async () => {
  const m = p.mission()!;
  const before = p.claudeCalls.filter((c) => c.kind === "worker").length;
  p.sandbox = null;
  p.ownerComment(p.prNo("intents", m.plan_pr!), "Use public packages instead");
  await p.until(() => p.claudeCalls.filter((c) => c.kind === "worker").length > before, 60);
  const repair = p.claudeCalls.filter((c) => c.kind === "worker").at(-1)!;
  expect(repair.prompt).toContain("Use public packages instead");
});
