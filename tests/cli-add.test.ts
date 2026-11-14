// `towercab add` and the overlap check (LOOP-124, INT-71).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main, terminal } from "../src/cli.ts";
import { type OverlapAnswer, overlapChild } from "./helpers/overlap-claude.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { bareRepo, git, tempDir } from "./helpers/world.ts";
import { intentMd } from "./intents/fixtures.ts";

let out = "";
let err = "";
const real = { interactive: terminal.interactive, ask: terminal.ask };
let asked: string[] = [];
let answers: string[] = [];
beforeEach(() => {
  out = "";
  err = "";
  asked = [];
  answers = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out += String(s);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    err += String(s);
    return true;
  });
  terminal.interactive = () => false;
  terminal.ask = async (q) => {
    asked.push(q);
    return answers.shift() ?? "";
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  terminal.interactive = real.interactive;
  terminal.ask = real.ask;
});

const body = "\n## Problem\n\nNo greeting.\n";
const GREET = "261021-0900";
const BUILT = "261021-0901";

function setup() {
  const intents = bareRepo({
    [`intents/${GREET}-greet/intent.md`]: intentMd("web", "u: 3\nsource: me\n", "Web greets visitors") + body,
    [`intents/${BUILT}-built/intent.md`]:
      intentMd("web", "u: 3\nsource: me\nstage: code\n", "Web has a login page") + body,
  });
  const dir = tempDir();
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${intents}"\n\n[github]\napp_id = 1\nme = "owner"\n\n[repos.web]\ngithub = "owner/web"\n`,
  );
  const tools = new FakeTools().on("systemctl", () => okResult());
  const g = ["--config", config, "--home", join(dir, "home")];
  const add = (...a: string[]) => main([...g, "add", "web: Web shows a hello form on the page", ...a], tools);
  const claude = (a: OverlapAnswer | string = {}, cost = 0.04, code = 0) =>
    tools.child("claude", overlapChild(a, cost, code));
  const count = () =>
    git(intents, "ls-tree", "-r", "--name-only", "main")
      .split("\n")
      .filter((f) => f.endsWith("intent.md")).length;
  return { intents, g, tools, add, claude, count };
}

const BOTH: OverlapAnswer = {
  matches: [
    { kind: "open", ref: GREET, how: "Both show a hello to visitors" },
    { kind: "open", ref: BUILT, how: "Both touch the first screen" },
  ],
};

test("cli: add with no overlap writes straight away", async () => {
  const w = setup();
  terminal.interactive = () => true;
  w.claude({});
  expect(await w.add("u4")).toBe(0);
  expect(out).toMatch(/^\d{6}-\d{4} intents\/\S+-web-shows-a-hello-form-on-the-page\/intent\.md$/m);
  expect(asked).toEqual([]);
  expect(w.tools.spawned).toHaveLength(1);
  expect(w.count()).toBe(3);
});

test("cli: add lists overlaps and asks", async () => {
  const w = setup();
  terminal.interactive = () => true;
  w.claude({ ...BOTH, title_note: "It names no product." });
  answers = ["n"];
  expect(await w.add()).toBe(1);
  expect(out).toContain(`1) open ${GREET} Web greets visitors\n  Both show a hello to visitors`);
  expect(out).toContain("Title: It names no product");
  expect(asked).toEqual([
    "Create anyway (y), add to one of them (its number), or cancel (n)? [y/n/<number>] ",
  ]);
  expect(err).toContain("towercab: cancelled");
  expect(w.count()).toBe(2);
});

test("cli: add creates anyway on y", async () => {
  const w = setup();
  terminal.interactive = () => true;
  w.claude(BOTH);
  answers = ["y"];
  expect(await w.add()).toBe(0);
  expect(out).toMatch(/\d{6}-\d{4} intents\/\S+\/intent\.md\n$/);
  expect(w.count()).toBe(3);
});

test("cli: add adds to the chosen intent", async () => {
  const w = setup();
  terminal.interactive = () => true;
  w.claude(BOTH);
  answers = ["1"];
  expect(await w.add()).toBe(0);
  expect(out).toContain(`added to ${GREET}`);
  expect(w.count()).toBe(2);
  const text = git(w.intents, "show", `main:intents/${GREET}-greet/intent.md`);
  expect(text).toContain("## Proposed outcome\n\nWeb shows a hello form on the page\n");
  expect(text).toContain("## Problem\n\nNo greeting.\n");
  expect(text.split("\n---\n")[0]).toContain("repo: web");
});

test("cli: add offers no number for an intent past design", async () => {
  const w = setup();
  terminal.interactive = () => true;
  w.claude({ matches: [{ kind: "open", ref: BUILT, how: "Both touch the first screen" }] });
  answers = ["1"];
  expect(await w.add()).toBe(1);
  expect(out).toContain(`open ${BUILT} Web has a login page\n  Both touch the first screen`);
  expect(out).not.toContain(`1) open ${BUILT}`);
  expect(out).toContain(`already past design: write a new intent and link ${BUILT}`);
  expect(asked).toEqual(["Create anyway (y) or cancel (n)? [y/n] "]);
  expect(w.count()).toBe(2);
});

test("cli: add cancels on n or end of input", async () => {
  const w = setup();
  terminal.interactive = () => true;
  for (const a of [["n"], [""], ["maybe"]]) {
    w.claude(BOTH);
    answers = a;
    out = err = "";
    expect(await w.add()).toBe(1);
    expect(err).toContain("towercab: cancelled");
  }
  expect(w.count()).toBe(2);
});

test("cli: add without a terminal writes and runs no check", async () => {
  const w = setup();
  expect(await w.add("u4", "i5")).toBe(0);
  expect(out).toMatch(/^\d{6}-\d{4} intents\/\S+\/intent\.md\n$/);
  expect(w.tools.spawned).toEqual([]);
  expect(asked).toEqual([]);
  expect(w.count()).toBe(3);
});

test("cli: add --check without a terminal warns and writes", async () => {
  const w = setup();
  w.claude(BOTH);
  expect(await w.add("--check")).toBe(0);
  expect(err).toContain(
    `towercab: warning: this may overlap open ${GREET} Web greets visitors\n  Both show a hello to visitors`,
  );
  expect(out).toMatch(/^\d{6}-\d{4} intents\/\S+\/intent\.md\n$/);
  expect(asked).toEqual([]);
  expect(w.count()).toBe(3);
});

test("cli: add --no-check skips the check", async () => {
  const w = setup();
  terminal.interactive = () => true;
  expect(await w.add("--no-check")).toBe(0);
  expect(w.tools.spawned).toEqual([]);
  expect(asked).toEqual([]);
  expect(w.count()).toBe(3);
  // Outside a terminal it changes nothing; with --check as well, skipping wins.
  terminal.interactive = () => false;
  expect(
    await main([...w.g, "add", "web: Web has a second hello form", "--check", "--no-check"], w.tools),
  ).toBe(0);
  expect(w.tools.spawned).toEqual([]);
  expect(w.count()).toBe(4);
});

test("cli: add says the check failed and asks", async () => {
  const w = setup();
  terminal.interactive = () => true;
  w.claude("nonsense");
  answers = ["y"];
  expect(await w.add()).toBe(0);
  expect(err).toMatch(/towercab: the overlap check failed: .* \(skipped\)/);
  expect(asked).toEqual(["Create anyway (y) or cancel (n)? [y/n] "]);
  expect(w.count()).toBe(3);
  // Declined: nothing is written. In a script with --check it writes anyway.
  w.claude("nonsense");
  answers = ["n"];
  expect(await main([...w.g, "add", "web: Web has a third hello form", "--check"], w.tools)).toBe(1);
  expect(w.count()).toBe(3);
  terminal.interactive = () => false;
  w.claude("nonsense");
  expect(await main([...w.g, "add", "web: Web has a fourth hello form", "--check"], w.tools)).toBe(0);
  expect(w.count()).toBe(4);
});

test("intents: add goes through createIntent", async () => {
  const w = setup();
  expect(await w.add("u4", "i5", "a2")).toBe(0);
  const path = /^\d{6}-\d{4} (\S+)$/m.exec(out)![1]!;
  const text = git(w.intents, "show", `main:${path}`);
  expect(text).toMatch(
    /^---\nrepo: web\nu: 4\ni: 5\na: 2\nsource: me\nstarted: \S+\n---\n\n# Intent: Web shows a hello form on the page\n$/,
  );
  // The writer refuses what INT-72 says, whichever way it is called.
  out = err = "";
  expect(await main([...w.g, "add", "nowhere: Something nobody can build here"], w.tools)).toBe(1);
  expect(err).toContain("nowhere is not one of Towercab's repos");
});
