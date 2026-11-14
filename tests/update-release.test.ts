// The update channel (LOOP-150) and the release channel's update check (LOOP-151), on a temp clone of
// a bare repo that the tests tag and push to.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { checkUpdate } from "../src/update.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { FakeTools, failResult, okResult } from "./helpers/tools.ts";
import { bareRepo, git, tempDir, testConfig } from "./helpers/world.ts";

function installed() {
  const bare = bareRepo({ "bin/towercab": "#!/bin/sh\n", "src/a.ts": "1\n" });
  const checkout = join(tempDir(), "towercab");
  git(tempDir(), "clone", "-q", bare, checkout);
  return { bare, checkout };
}

function tools(checkout: string, doctorOk = true): FakeTools {
  return new FakeTools()
    .on("npm", () => okResult())
    .on(join(checkout, "bin", "towercab"), () => (doctorOk ? okResult("ok") : failResult("config: missing")));
}

function clone(bare: string): string {
  const w = join(tempDir("tc-rel-"), "w");
  git(dirname(w), "clone", "-q", bare, w);
  return w;
}

/** A new commit on main of `bare`, tagged `tag`; returns the commit. */
function release(
  bare: string,
  tag: string,
  files: Record<string, string> = { "src/a.ts": `${tag}\n` },
): string {
  const w = clone(bare);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(w, path)), { recursive: true });
    writeFileSync(join(w, path), text);
  }
  git(w, "add", "-A");
  git(w, "commit", "-q", "-m", tag);
  git(w, "push", "-q", "origin", "main");
  git(w, "tag", tag);
  git(w, "push", "-q", "origin", tag);
  return git(w, "rev-parse", "HEAD").trim();
}

/** A tag on a commit that is not on main (only the tag is pushed). */
function tagOffMain(bare: string, tag: string): string {
  const w = clone(bare);
  git(w, "checkout", "-q", "-b", "side");
  writeFileSync(join(w, "src/a.ts"), `${tag}\n`);
  git(w, "commit", "-q", "-am", tag);
  git(w, "tag", tag);
  git(w, "push", "-q", "origin", tag);
  return git(w, "rev-parse", "HEAD").trim();
}

function commitOnMain(bare: string, text: string): string {
  const w = clone(bare);
  writeFileSync(join(w, "src/a.ts"), text);
  git(w, "commit", "-q", "-am", text.trim());
  git(w, "push", "-q", "origin", "main");
  return git(w, "rev-parse", "HEAD").trim();
}

const head = (checkout: string) => git(checkout, "rev-parse", "HEAD").trim();
const branch = (checkout: string) => git(checkout, "rev-parse", "--abbrev-ref", "HEAD").trim();
const sitOn = (checkout: string, tag: string) => {
  git(checkout, "fetch", "-q", "--tags", "origin");
  git(checkout, "checkout", "-q", "--detach", tag);
};

test("update: channel defaults to main", () => {
  expect(testConfig().update.channel).toBe("main");
  expect(testConfig({ update: { channel: "release" } }).update.channel).toBe("release");
});

test("update: an unknown channel fails the config", () => {
  expect(() => testConfig({ update: { channel: "beta" } })).toThrow(
    'update.channel must be "main" or "release"',
  );
  expect(() => testConfig({ update: { channel: true } })).toThrow(
    'update.channel must be "main" or "release"',
  );
});

test("update: auto false stops updates on the release channel", async () => {
  const run = async (auto: boolean) => {
    const { bare, checkout } = installed();
    const p = new Pipe(TARGET, {
      "intents/261026-1000-t/intent.md": intent({ title: "T", repo: "web", u: 4, i: 4, extra: "" }),
    });
    p.tools.on("npm", () => okResult());
    p.tools.on(join(checkout, "bin", "towercab"), () => okResult("ok"));
    await p.start(
      { repos: { web: { github: "owner/web" } }, update: { auto, channel: "release" } },
      { selfUpdate: true, codeRoot: checkout },
    );
    const tag = release(bare, "v1.0.0");
    for (let i = 0; i < 4; i++) {
      await p.loop.pass();
      p.clock.advance(61);
    }
    return { moved: head(checkout) === tag, code: p.loop.exitCode };
  };
  expect(await run(false)).toEqual({ moved: false, code: 0 });
  expect(await run(true)).toEqual({ moved: true, code: 75 });
});

test("update: the main channel moves a checkout on a tag back to main", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.0.0");
  const tip = commitOnMain(bare, "later\n");
  sitOn(checkout, "v1.0.0");
  const t = tools(checkout);
  const r = await checkUpdate({ tools: t, checkout, idle: () => true, channel: "main" });
  expect(r.kind).toBe("updated");
  expect(branch(checkout)).toBe("main");
  expect(head(checkout)).toBe(tip);
  expect(t.lines(join(checkout, "bin", "towercab"))).toEqual(["doctor --quick"]);
});

test("update: moving back to main drains first", async () => {
  const { bare, checkout } = installed();
  const tagged = release(bare, "v1.0.0");
  sitOn(checkout, "v1.0.0");
  const r = await checkUpdate({ tools: tools(checkout), checkout, idle: () => false, channel: "main" });
  expect(r.kind).toBe("waiting");
  expect(head(checkout)).toBe(tagged);
  expect(branch(checkout)).toBe("HEAD");
});

test("update: a failed move back to main returns to the tag", async () => {
  const { bare, checkout } = installed();
  const tagged = release(bare, "v1.0.0");
  commitOnMain(bare, "later\n");
  sitOn(checkout, "v1.0.0");
  const r = await checkUpdate({ tools: tools(checkout, false), checkout, idle: () => true, channel: "main" });
  expect(r.kind).toBe("failed");
  expect(head(checkout)).toBe(tagged);
  expect(branch(checkout)).toBe("HEAD");
});

test("update: a dirty checkout on a tag is left alone on the main channel", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.0.0");
  sitOn(checkout, "v1.0.0");
  writeFileSync(join(checkout, "src/a.ts"), "my edit\n");
  expect(
    await checkUpdate({ tools: tools(checkout), checkout, idle: () => true, channel: "main" }),
  ).toMatchObject({
    kind: "none",
    why: "the checkout has local changes",
  });
  expect(branch(checkout)).toBe("HEAD");
});

test("update: release channel ignores a new commit on main", async () => {
  const { bare, checkout } = installed();
  const tagged = release(bare, "v1.0.0");
  git(checkout, "pull", "-q", "--ff-only");
  commitOnMain(bare, "later\n");
  const r = await checkUpdate({ tools: tools(checkout), checkout, idle: () => true, channel: "release" });
  expect(r.kind).toBe("none");
  expect(head(checkout)).toBe(tagged);
  expect(branch(checkout)).toBe("main");
});

test("update: release channel moves to a newer tag", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.0.0");
  const newer = release(bare, "v1.1.0");
  commitOnMain(bare, "later\n");
  const t = tools(checkout);
  expect(await checkUpdate({ tools: t, checkout, idle: () => false, channel: "release" })).toMatchObject({
    kind: "waiting",
    to: "v1.1.0",
    target: newer,
  });
  const r = await checkUpdate({ tools: t, checkout, idle: () => true, channel: "release" });
  expect(r).toMatchObject({ kind: "updated", to: "v1.1.0" });
  expect(head(checkout)).toBe(newer);
  expect(branch(checkout)).toBe("HEAD");
  expect(t.lines(join(checkout, "bin", "towercab"))).toEqual(["doctor --quick"]);
});

test("update: release channel never moves to an older tag", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.0.0");
  const current = release(bare, "v1.1.0");
  sitOn(checkout, "v1.1.0");
  const r = await checkUpdate({ tools: tools(checkout), checkout, idle: () => true, channel: "release" });
  expect(r.kind).toBe("none");
  expect(head(checkout)).toBe(current);
});

test("update: tags compare as numbers", async () => {
  const { bare, checkout } = installed();
  const big = release(bare, "v1.10.0");
  release(bare, "v1.9.0");
  const r = await checkUpdate({ tools: tools(checkout), checkout, idle: () => true, channel: "release" });
  expect(r).toMatchObject({ kind: "updated", to: "v1.10.0" });
  expect(head(checkout)).toBe(big);
});

test("update: tags that are not vMAJOR.MINOR.PATCH are ignored", async () => {
  const { bare, checkout } = installed();
  const before = head(checkout);
  for (const tag of ["v1.0", "web-v1.0.0", "v1.0.0.1", "1.0.0", "v1"]) release(bare, tag);
  const r = await checkUpdate({ tools: tools(checkout), checkout, idle: () => true, channel: "release" });
  expect(r.kind).toBe("none");
  expect(head(checkout)).toBe(before);
});

test("update: a pre-release tag is never installed", async () => {
  const { bare, checkout } = installed();
  const final = release(bare, "v1.1.0");
  release(bare, "v1.2.0-rc1");
  const r = await checkUpdate({ tools: tools(checkout), checkout, idle: () => true, channel: "release" });
  expect(r).toMatchObject({ kind: "updated", to: "v1.1.0" });
  expect(head(checkout)).toBe(final);
});

test("update: a tag not on main is skipped and logged", async () => {
  const { bare, checkout } = installed();
  const final = release(bare, "v1.0.0");
  tagOffMain(bare, "v2.0.0");
  const log: string[] = [];
  const skipped = new Set<string>();
  const d = {
    tools: tools(checkout),
    checkout,
    idle: () => true,
    channel: "release" as const,
    log: (m: string) => log.push(m),
    skipped,
  };
  expect(await checkUpdate(d)).toMatchObject({ kind: "updated", to: "v1.0.0" });
  expect(head(checkout)).toBe(final);
  expect(log).toEqual(["release v2.0.0 skipped: its commit is not on main"]);
  // The explanation is given once while the loop runs.
  await checkUpdate(d);
  expect(log).toHaveLength(1);
});

test("update: the newest tag on main is chosen over a newer tag off main", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.0.0");
  const wanted = release(bare, "v1.1.0");
  tagOffMain(bare, "v3.0.0");
  const r = await checkUpdate({ tools: tools(checkout), checkout, idle: () => true, channel: "release" });
  expect(r).toMatchObject({ kind: "updated", to: "v1.1.0" });
  expect(head(checkout)).toBe(wanted);
});

test("update: no release tags keeps the running version", async () => {
  const { bare, checkout } = installed();
  commitOnMain(bare, "later\n");
  const before = head(checkout);
  const t = tools(checkout);
  const r = await checkUpdate({ tools: t, checkout, idle: () => true, channel: "release" });
  expect(r).toMatchObject({ kind: "none" });
  expect(head(checkout)).toBe(before);
  expect(t.lines("npm")).toEqual([]);
});

test("update: a checkout on a release tag is updated", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.0.0");
  sitOn(checkout, "v1.0.0");
  const newer = release(bare, "v1.1.0");
  const r = await checkUpdate({ tools: tools(checkout), checkout, idle: () => true, channel: "release" });
  expect(r).toMatchObject({ kind: "updated", to: "v1.1.0" });
  expect(head(checkout)).toBe(newer);
});

test("update: a failed check on a tag rolls back to the previous position", async () => {
  // From a branch.
  const a = installed();
  const start = head(a.checkout);
  release(a.bare, "v1.0.0");
  const r = await checkUpdate({
    tools: tools(a.checkout, false),
    checkout: a.checkout,
    idle: () => true,
    channel: "release",
  });
  expect(r).toMatchObject({ kind: "failed", to: "v1.0.0" });
  expect(head(a.checkout)).toBe(start);
  expect(branch(a.checkout)).toBe("main");
  // From an earlier tag.
  const b = installed();
  const old = release(b.bare, "v1.0.0");
  sitOn(b.checkout, "v1.0.0");
  release(b.bare, "v1.1.0");
  const r2 = await checkUpdate({
    tools: tools(b.checkout, false),
    checkout: b.checkout,
    idle: () => true,
    channel: "release",
  });
  expect(r2).toMatchObject({ kind: "failed", to: "v1.1.0" });
  expect(head(b.checkout)).toBe(old);
  expect(branch(b.checkout)).toBe("HEAD");
});

test("update: a failed tag is not drained for again", async () => {
  const { bare, checkout } = installed();
  const first = release(bare, "v1.0.0");
  const d = { tools: tools(checkout), checkout, idle: () => false, channel: "release" as const };
  expect(await checkUpdate({ ...d, failed: first })).toMatchObject({ kind: "none" });
  // A newer tag is tried.
  const second = release(bare, "v1.1.0");
  expect(await checkUpdate({ ...d, failed: first })).toMatchObject({ kind: "waiting", target: second });
});
