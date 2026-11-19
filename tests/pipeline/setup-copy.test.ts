// The install output of the secret pass reaches the checkout only as ignored, untracked paths (PIP-214).

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { copyOut, exportTree } from "../../src/pipeline/setup-pass.ts";
import { FakeTools } from "../helpers/tools.ts";
import { git, tempDir } from "../helpers/world.ts";

/** A checkout whose main tracks `kept.gen` (although `*.gen` is ignored) and a clean export of its tree. */
async function world(): Promise<{ tools: FakeTools; dir: string; tree: string; base: string }> {
  const dir = join(tempDir(), "co");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".venv/\nnode_modules/\n*.gen\n");
  writeFileSync(join(dir, "kept.gen"), "MAIN\n");
  writeFileSync(join(dir, "package.json"), "{}\n");
  git(dir, "add", "-A");
  git(dir, "add", "-f", "kept.gen");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD").trim();
  const tree = `${dir}-setup-tree`;
  mkdirSync(tree);
  const tools = new FakeTools();
  await exportTree(tools, dir, base, tree);
  return { tools, dir, tree, base };
}

test("pipeline: setup with secrets runs on a fresh export of the base commit's tree", async () => {
  const w = await world();
  expect(existsSync(join(w.tree, ".git"))).toBe(false);
  expect(readFileSync(join(w.tree, "package.json"), "utf8")).toBe("{}\n");
  expect(readFileSync(join(w.tree, ".gitignore"), "utf8")).toContain(".venv/");
});

test("pipeline: only ignored untracked output is copied", async () => {
  const w = await world();
  mkdirSync(join(w.tree, ".venv", "lib"), { recursive: true });
  writeFileSync(join(w.tree, ".venv", "lib", "pkg.py"), "x");
  mkdirSync(join(w.tree, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(w.tree, "node_modules", "pkg.txt"), "y");
  writeFileSync(join(w.tree, "leftover.txt"), "not ignored");
  const left = await copyOut(w.tools, w.dir, w.tree);
  expect(readFileSync(join(w.dir, ".venv", "lib", "pkg.py"), "utf8")).toBe("x");
  expect(readFileSync(join(w.dir, "node_modules", "pkg.txt"), "utf8")).toBe("y");
  expect(existsSync(join(w.dir, "leftover.txt"))).toBe(false);
  expect(left).toEqual(["leftover.txt"]);
});

test("pipeline: the copy never overwrites a tracked file", async () => {
  const w = await world();
  // Setup rewrote a file main tracks, and one the branch tracks although it is ignored.
  writeFileSync(join(w.tree, "kept.gen"), "SETUP\n");
  writeFileSync(join(w.tree, "branch.gen"), "SETUP\n");
  writeFileSync(join(w.dir, "branch.gen"), "BRANCH\n");
  git(w.dir, "add", "-f", "branch.gen");
  writeFileSync(join(w.tree, "other.gen"), "NEW\n");
  await copyOut(w.tools, w.dir, w.tree);
  expect(readFileSync(join(w.dir, "kept.gen"), "utf8")).toBe("MAIN\n");
  expect(readFileSync(join(w.dir, "branch.gen"), "utf8")).toBe("BRANCH\n");
  expect(readFileSync(join(w.dir, "other.gen"), "utf8")).toBe("NEW\n");
});

test("pipeline: the copy clears setuid bits and keeps links as links", async () => {
  const w = await world();
  mkdirSync(join(w.tree, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(w.tree, "node_modules", "tool.js"), "#!/bin/sh\n");
  chmodSync(join(w.tree, "node_modules", "tool.js"), 0o4755);
  symlinkSync("../tool.js", join(w.tree, "node_modules", ".bin", "tool"));
  await copyOut(w.tools, w.dir, w.tree);
  const tool = lstatSync(join(w.dir, "node_modules", "tool.js"));
  expect(tool.mode & 0o6000).toBe(0);
  expect(tool.mode & 0o777).toBe(0o755);
  expect(lstatSync(join(w.dir, "node_modules", ".bin", "tool")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(w.dir, "node_modules", ".bin", "tool"))).toBe("../tool.js");
});
