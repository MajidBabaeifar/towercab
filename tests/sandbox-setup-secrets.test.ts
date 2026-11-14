// The setup secrets stay out of the sandbox of the worker and the checks, and the secret pass sees only its own
// tree (PIP-212, PIP-214). Real bwrap; without it each attempt is skipped with a note, and CI must have it.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, type TestContext, test } from "vitest";
import { sandboxArgv, sandboxEnv } from "../src/pipeline/sandbox.ts";
import {
  BWRAP_REQUIRED,
  bwrapUsable,
  escapeMode,
  inSandbox,
  type Plant,
  plant,
  SKIP_NOTE,
} from "./helpers/escape.ts";

const usable = bwrapUsable();
let p: Plant;

beforeAll(() => {
  p = plant();
});
afterAll(() => p.cleanup());

function attempt(body: () => void): (ctx: TestContext) => void {
  return (ctx) => {
    const mode = escapeMode(usable, BWRAP_REQUIRED);
    if (mode === "fail") throw new Error("bwrap is not usable here, and CI must have it (PIP-160)");
    if (mode === "skip") ctx.skip(SKIP_NOTE);
    body();
  };
}

test(
  "pipeline: the setup secrets directory is unreadable in the sandbox",
  attempt(() => {
    const dir = join(p.home, ".config", "towercab", "setup-secrets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "web.env"), "NPM_TOKEN=SETUP-SECRET-CANARY\n");
    const r = inSandbox(p, `cat "${join(dir, "web.env")}" "$HOME/.config/towercab/setup-secrets/web.env"`);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("SETUP-SECRET-CANARY");
  }),
);

test(
  "pipeline: the secret pass sees its own tree and not the worker's checkout",
  attempt(() => {
    const tree = `${p.checkout}-setup-tree`;
    mkdirSync(join(p.checkout, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(p.checkout, "node_modules", ".bin", "npm"), "PLANTED");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "package.json"), "{}");
    const argv = sandboxArgv({
      checkout: p.checkout,
      home: p.home,
      cache: null,
      cacheWritable: false,
      line: "ls -A; test ! -e node_modules && echo no-planted-tool",
      tree,
    });
    const r = spawnSync(argv[0]!, argv.slice(1), {
      cwd: tree,
      env: sandboxEnv(p.home, null, {}),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("package.json");
    expect(r.stdout).toContain("no-planted-tool");
    expect(r.stdout).not.toContain(".git");
  }),
);
