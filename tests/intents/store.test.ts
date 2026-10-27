// The store over a local bare repo: layout, git sync, unreadable files, the interface
// (INT-1, 2, 3, 4, 5, 10, 11, 12).

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { type GitStore, openStore, type StoreOptions } from "../../src/intents/store.ts";
import { RefusedError, SyncError } from "../../src/intents/types.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, git, pushFiles, tempDir } from "../helpers/world.ts";
import { ids, intentMd } from "./fixtures.ts";

const NOW = new Date(2026, 9, 21, 9, 5, 7);

interface World {
  remote: string;
  path: string;
  store: GitStore;
  logged: string[];
  open(o?: Partial<StoreOptions>): Promise<GitStore>;
  file(path: string): string;
  has(path: string): boolean;
  log(): string[];
  head(): string;
}

async function world(files: Record<string, string>): Promise<World> {
  const remote = bareRepo(files);
  const path = join(tempDir(), "intents");
  const logged: string[] = [];
  const open = (o: Partial<StoreOptions> = {}) =>
    openStore({ remote, path, tools: new FakeTools(), log: (t) => logged.push(t), now: () => NOW, ...o });
  return {
    remote,
    path,
    logged,
    store: await open(),
    open,
    file: (p) => git(remote, "show", `main:${p}`),
    has: (p) => git(remote, "ls-tree", "--name-only", "main", "--", p).trim() === p,
    log: () => git(remote, "log", "--format=%s", "main").trim().split("\n"),
    head: () => git(remote, "rev-parse", "main").trim(),
  };
}

/** A clone the owner works in. */
function mine(remote: string): string {
  const me = join(tempDir(), "me");
  git(dirname(me), "clone", "-q", remote, me);
  return me;
}

/** A `pre-receive` hook on the remote that rejects the first `n` pushes. */
function rejectPushes(remote: string, n: number): void {
  const count = join(dirname(remote), `pushes-${n}`);
  const hook = join(remote, "hooks/pre-receive");
  writeFileSync(
    hook,
    `#!/bin/sh\nn=$(cat '${count}' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '${count}'\n` +
      `if [ $n -le ${n} ]; then echo "test: push $n rejected" >&2; exit 1; fi\nexit 0\n`,
  );
  chmodSync(hook, 0o755);
}

const clean = (path: string) => git(path, "status", "--porcelain").trim() === "";

test("intents: layout of open and done folders", async () => {
  const w = await world({
    "intents/261020-0721-rust-crate/intent.md": intentMd("towercab", "u: 4\ni: 5\n", "Rust crate"),
    "intents/261020-0721-2-priority/intent.md": intentMd("towercab", "stage: build\n", "Priority"),
    "intents/261020-0721-2-priority/plan.md": "# Plan\n",
    "intents/261019-0800-shipped/intent.md": intentMd("towercab", "stage: done\n", "Shipped in place"),
    "done/261015-1446-rename/intent.md": intentMd("towercab", "stage: done\n", "Rename"),
    "intents/notes.md": "plain files are ignored\n",
    "intents/scratch/keep.txt": "x\n",
    "intents/261020-0900-empty/.gitkeep": "",
    "done/legacy.md": "2026-10-15 261015-1710 towercab: Old line · towercab#6\n",
  });
  expect(existsSync(join(w.path, ".git"))).toBe(true);
  const l = await w.store.list();
  expect(ids(l.open)).toEqual(["261020-0721", "261020-0721-2"]);
  expect(ids(l.done)).toEqual(["261019-0800", "261015-1446"]);
  expect(l.open[0]).toMatchObject({ dir: "intents/261020-0721-rust-crate", slug: "rust-crate", done: false });
  expect(l.open[1]!.stage).toBe("code");
  expect(l.done[0]!.dir).toBe("intents/261019-0800-shipped");
  expect(l.done[1]).toMatchObject({ dir: "done/261015-1446-rename", done: true });
  expect(l.unreadable).toEqual([
    { path: "intents/261020-0900-empty", reason: "no intent.md", id: "261020-0900" },
    { path: "intents/scratch", reason: "not an <id>-<slug> folder", id: null },
  ]);
  expect([...l.doneIds].sort()).toEqual(["261015-1446", "261015-1710", "261019-0800"]);
  expect(l.head).toBe(w.head());

  // A write regenerates both views at the root.
  await w.store.add({ repo: "towercab", title: "Layout check" }, NOW);
  const todo = w.file("TODO.md");
  expect(todo).toContain(
    "- [261020-0721](intents/261020-0721-rust-crate/intent.md) towercab: Rust crate · p14 u4 i5\n",
  );
  expect(todo).toContain(
    "- [261020-0721-2](intents/261020-0721-2-priority/intent.md) towercab: Priority · code\n",
  );
  expect(todo).toContain("- intents/scratch: not an <id>-<slug> folder\n");
  const done = w.file("DONE.md");
  expect(done).toContain("[261015-1446](done/261015-1446-rename/intent.md) towercab: Rename · no PR");
  expect(done.endsWith("## Before intents\n\n2026-10-15 261015-1710 towercab: Old line · towercab#6\n")).toBe(
    true,
  );
  expect(w.file("intents/261020-0721-2-priority/plan.md")).toBe("# Plan\n");
  // An existing checkout is used as it is; plan.md is read from main.
  const again = await w.open();
  expect((await again.list()).open).toHaveLength(3);
  expect(await again.readFile("intents/261020-0721-2-priority/plan.md")).toBe("# Plan\n");
  expect(await again.readFile("intents/none.md")).toBeNull();
  await expect(again.readFile("../x")).rejects.toThrow(RefusedError);
});

test("intents: symlinks are never followed", async () => {
  const w = await world({ "intents/261020-0721-real/intent.md": intentMd("towercab", "", "Real") });
  const outside = join(tempDir(), "outside");
  mkdirSync(outside);
  const text = intentMd("towercab", "", "Outside");
  writeFileSync(join(outside, "intent.md"), text);
  const me = mine(w.remote);
  symlinkSync(outside, join(me, "intents/261020-0800-link"));
  mkdirSync(join(me, "intents/261020-0900-file"));
  symlinkSync(join(outside, "intent.md"), join(me, "intents/261020-0900-file/intent.md"));
  git(me, "add", "-A");
  git(me, "commit", "-q", "-m", "links");
  git(me, "push", "-q", "origin", "HEAD:main");

  const l = await w.store.list();
  expect(ids(l.open)).toEqual(["261020-0721"]);
  expect(l.unreadable.map((u) => [u.path, u.reason])).toEqual([
    ["intents/261020-0800-link", "symlink"],
    ["intents/261020-0900-file/intent.md", "symlink"],
  ]);
  await expect(w.store.update("0900", "touch", () => {})).rejects.toThrow(
    "intents/261020-0900-file/intent.md: symlink",
  );
  await w.store.update("0721", "start", (e) => e.setField("stage", "spec"));
  expect(readFileSync(join(outside, "intent.md"), "utf8")).toBe(text);

  // A symlinked view is never written through.
  git(me, "pull", "-q", "--rebase", "origin", "main");
  git(me, "rm", "-q", "DONE.md");
  symlinkSync(join(outside, "intent.md"), join(me, "DONE.md"));
  git(me, "add", "-A");
  git(me, "commit", "-q", "-m", "linked view");
  git(me, "push", "-q", "origin", "HEAD:main");
  await expect(w.store.add({ repo: "towercab", title: "Through a link" }, NOW)).rejects.toThrow(
    new RefusedError("DONE.md: symlink"),
  );
  expect(readFileSync(join(outside, "intent.md"), "utf8")).toBe(text);
});

test("intents: add writes a thin intent", async () => {
  const w = await world({
    "intents/261021-0905-open/intent.md": intentMd("towercab", "", "Open"),
    "done/261021-0905-2-finished/intent.md": intentMd("towercab", "stage: done\n", "Finished"),
    "intents/261021-0905-3-broken/intent.md": "not an intent\n",
    "done/legacy.md": "2026-10-21 261021-0905-4 towercab: Old\n",
    "intents/261021-0905-5-Bad_Slug/intent.md": intentMd("towercab", "", "Bad slug"),
  });
  // Every folder's ID (readable or not, open or done) and every legacy ID is taken (INT-3).
  const got = await w.store.add({ repo: "towercab", title: "Rust crate and intent store", u: 4, i: 5 }, NOW);
  expect(got).toMatchObject({
    id: "261021-0905-6",
    dir: "intents/261021-0905-6-rust-crate-and-intent-store",
    u: 4,
    i: 5,
    a: null,
    source: "me",
    stage: null,
  });
  const text = w.file("intents/261021-0905-6-rust-crate-and-intent-store/intent.md");
  expect(text).toMatch(
    /^---\nrepo: towercab\nu: 4\ni: 5\nsource: me\nstarted: 2026-10-21T09:05:07[+-]\d\d:\d\d\n---\n\n# Intent: Rust crate and intent store\n$/,
  );
  expect(w.log()[0]).toBe("towercab: add 261021-0905-6");
  expect(w.file("TODO.md")).toContain(
    "- [261021-0905-6](intents/261021-0905-6-rust-crate-and-intent-store/intent.md) towercab: Rust crate and intent store · p14 u4 i5\n",
  );
  // `a` only when given; a thin intent runs as written.
  await w.store.add({ repo: "towercab", title: "Bare", a: 2 }, new Date(2026, 9, 21, 9, 6));
  expect(w.file("intents/261021-0906-bare/intent.md")).toMatch(
    /^---\nrepo: towercab\na: 2\nsource: me\nstarted: /,
  );
  expect(await w.store.get("0906")).toMatchObject({ title: "Bare", u: null, i: null, a: 2 });
  // Dropped: its ID stays taken.
  await w.store.update("0906", "drop", (e) => e.setField("stage", "dropped"));
  expect((await w.store.add({ repo: "towercab", title: "Again" }, new Date(2026, 9, 21, 9, 6))).id).toBe(
    "261021-0906-2",
  );
  for (const n of [
    { repo: "towercab", title: "" },
    { repo: "towercab", title: "two\nlines" },
    { repo: "towercab", title: "ok", u: 6 },
    { repo: "bad repo", title: "ok" },
  ]) {
    await expect(w.store.add(n, NOW)).rejects.toThrow(RefusedError);
  }
});

test("intents: only main is accepted", async () => {
  const w = await world({ "intents/261020-0721-on-main/intent.md": intentMd("towercab", "", "On main") });
  // A machine-written intent waits on its own branch until merged.
  const me = mine(w.remote);
  git(me, "checkout", "-q", "-b", "intent/261021-1000-machine");
  mkdirSync(join(me, "intents/261021-1000-machine"));
  writeFileSync(join(me, "intents/261021-1000-machine/intent.md"), intentMd("towercab", "", "Machine"));
  git(me, "add", "-A");
  git(me, "commit", "-q", "-m", "draft");
  git(me, "push", "-q", "origin", "HEAD:intent/261021-1000-machine");
  expect(ids((await w.store.list()).open)).toEqual(["261020-0721"]);
  await expect(w.store.get("1000")).rejects.toThrow("no open intent matches 1000");
  // Merged → on main → accepted.
  git(me, "push", "-q", "origin", "HEAD:main");
  expect(ids((await w.store.list()).open)).toEqual(["261020-0721", "261021-1000"]);
  // A checkout on another branch is refused, also when switched after open.
  git(w.path, "checkout", "-q", "-b", "feature");
  const want = `intents: ${w.path} is on feature, not main`;
  await expect(w.open()).rejects.toThrow(new RefusedError(want));
  await expect(w.store.list()).rejects.toThrow(want);
  await expect(w.store.add({ repo: "towercab", title: "On feature" }, NOW)).rejects.toThrow(want);
});

test("intents: done moves the folder", async () => {
  const w = await world({
    "intents/261020-0721-ship/intent.md": intentMd("towercab", "u: 4\ni: 5\nstage: code\n", "Ship it"),
    "intents/261020-0721-ship/plan.md": "# Plan\n",
    "intents/261020-0723-keep/intent.md": intentMd(
      "towercab",
      "finished: 2026-10-19T08:00:00+02:00\n",
      "Keep",
    ),
  });
  const pr = "https://github.com/o/towercab/pull/9";
  const got = await w.store.update("0721", "done", (e) => {
    e.setField("stage", "done");
    e.setField("pr", pr);
    e.setField("cost", 1.5);
    e.setField("agent_time", 90);
    e.setField("attempts", 1);
  });
  expect(got).toMatchObject({ dir: "done/261020-0721-ship", done: true, stage: "done" });
  expect(got.finished).toMatch(/^2026-10-21T09:05:07/);
  expect(w.log()[0]).toBe("towercab: done 261020-0721");
  expect(w.has("intents/261020-0721-ship/intent.md")).toBe(false);
  expect(w.file("done/261020-0721-ship/plan.md")).toBe("# Plan\n");
  const status = git(w.remote, "diff", "--name-status", "-M", "main~1", "main");
  expect(status).toContain("intents/261020-0721-ship/plan.md\tdone/261020-0721-ship/plan.md");
  expect(w.file("DONE.md")).toContain(
    `- 2026-10-21 [261020-0721](done/261020-0721-ship/intent.md) towercab: Ship it · [towercab#9](${pr}) · $1.50 · 1m30s · 1\n`,
  );
  expect(w.file("TODO.md")).not.toContain("Ship it");
  // An existing `finished` is kept.
  await w.store.update("0723", "done", (e) => e.setField("stage", "done"));
  expect(w.file("done/261020-0723-keep/intent.md")).toContain("finished: 2026-10-19T08:00:00+02:00\n");
  expect(ids((await w.store.list()).done)).toEqual(["261020-0723", "261020-0721"]);
});

test("intents: concurrent edits are both kept", async () => {
  const shared = intentMd("towercab", "u: 4\ni: 5\n", "Shared");
  const w = await world({
    "intents/261020-0721-shared/intent.md": shared,
    "intents/261020-0722-other/intent.md": intentMd("towercab", "", "Other"),
  });
  let calls = 0;
  // While Towercab writes, the owner pushes an edit to the same intent: the push is rejected, the
  // change is replayed on the owner's commit, and both edits survive.
  const got = await w.store.update("0721", "start", (e) => {
    calls++;
    if (calls === 1) {
      pushFiles(
        w.remote,
        { "intents/261020-0721-shared/intent.md": shared.replace("i: 5", "i: 2") },
        "my edit",
      );
    }
    e.setField("stage", "spec");
  });
  expect(calls).toBe(2);
  expect([got.i, got.stage]).toEqual([2, "spec"]);
  expect(w.file("intents/261020-0721-shared/intent.md")).toBe(
    "---\nrepo: towercab\nu: 4\ni: 2\nstage: spec\n---\n\n# Intent: Shared\n",
  );
  expect(w.log().slice(0, 2)).toEqual(["towercab: start 261020-0721", "my edit"]);
  expect(clean(w.path)).toBe(true);
  // The owner's edits before Towercab's read are pulled first, never overwritten; other files keep their bytes.
  const odd = "---\nrepo: towercab # mine\nu:   5\n---\n# Intent: Other, renamed\nno newline";
  pushFiles(w.remote, { "intents/261020-0722-other/intent.md": odd }, "rename");
  await w.store.update("0721", "plan", (e) => e.setField("stage", "plan"));
  expect(w.file("intents/261020-0722-other/intent.md")).toBe(odd);
  expect(w.file("TODO.md")).toContain("towercab: Other, renamed · p11 u5 i3\n");
});

test("intents: a rejected push replays the change", async () => {
  const w = await world({ "intents/261020-0721-x/intent.md": intentMd("towercab", "", "X") });
  rejectPushes(w.remote, 2);
  let calls = 0;
  await w.store.update("0721", "start", (e) => {
    calls++;
    e.setField("stage", "spec");
  });
  expect(calls).toBe(3);
  expect(w.log().slice(0, 2)).toEqual(["towercab: start 261020-0721", "seed"]);
  // Rejected every time: 1 push + 3 retries, then give up with nothing left behind.
  const head = w.head();
  rejectPushes(w.remote, 1000);
  calls = 0;
  const err = await w.store
    .update("0721", "plan", (e) => {
      calls++;
      e.setField("stage", "plan");
    })
    .catch((e: unknown) => e);
  expect(calls).toBe(4);
  expect(err).toBeInstanceOf(SyncError);
  expect((err as Error).message).toMatch(/^push failed 4 times: .*test: push/);
  expect(w.head()).toBe(head);
  expect(git(w.path, "rev-parse", "HEAD")).toBe(git(w.path, "rev-parse", "origin/main"));
  expect(clean(w.path)).toBe(true);
  expect((await w.store.get("0721")).stage).toBe("spec");
});

test("intents: an unpushed commit is recovered", async () => {
  const w = await world({ "intents/261020-0721-x/intent.md": intentMd("towercab", "", "X") });
  await w.store.add({ repo: "towercab", title: "First" }, NOW);
  const b = await openStore({ remote: w.remote, path: join(tempDir(), "b"), tools: new FakeTools() });
  // A write stopped between its commit and its push; meanwhile B adds one, so the views conflict.
  // The next read rebases (views from main), regenerates them and pushes.
  mkdirSync(join(w.path, "intents/261021-1000-crashed"));
  writeFileSync(join(w.path, "intents/261021-1000-crashed/intent.md"), intentMd("towercab", "", "Crashed"));
  writeFileSync(join(w.path, "TODO.md"), "# TODO\n\n<!-- generated by towercab, stale -->\n\nA's view\n");
  git(w.path, "add", "-A");
  git(w.path, "commit", "-q", "-m", "towercab: add 261021-1000");
  await b.add({ repo: "towercab", title: "From B" }, new Date(2026, 9, 21, 11, 0));
  const l = await w.store.list();
  expect(l.open.map((i) => i.title)).toEqual(expect.arrayContaining(["Crashed", "From B"]));
  expect(w.has("intents/261021-1000-crashed/intent.md")).toBe(true);
  const todo = w.file("TODO.md");
  expect(todo).toContain("Crashed");
  expect(todo).toContain("From B");
  expect(todo).not.toContain("A's view");
  expect(w.log().slice(0, 3)).toEqual([
    "towercab: views",
    "towercab: add 261021-1000",
    "towercab: add 261021-1100",
  ]);
  expect(clean(w.path)).toBe(true);

  // A local commit that conflicts outside the views is dropped and logged; the store goes on.
  const x = "intents/261020-0721-x/intent.md";
  writeFileSync(join(w.path, x), intentMd("towercab", "u: 1\n", "X"));
  git(w.path, "commit", "-q", "-am", "local edit");
  pushFiles(w.remote, { [x]: intentMd("towercab", "u: 5\n", "X") }, "my edit");
  expect((await w.store.get("0721")).u).toBe(5);
  expect(w.logged).toEqual(["intents: local commits conflict with origin/main, dropped: local edit"]);
  expect(clean(w.path)).toBe(true);

  // A run killed mid-rebase, and half-written files: the next open aborts and discards them.
  writeFileSync(join(w.path, "TODO.md"), "# TODO\n\n<!-- generated by towercab, stale -->\n\nlocal\n");
  git(w.path, "commit", "-q", "-am", "local view");
  await b.add({ repo: "towercab", title: "Third" }, new Date(2026, 9, 21, 12, 0));
  git(w.path, "fetch", "-q", "origin");
  expect(() => git(w.path, "rebase", "-q", "origin/main")).toThrow();
  expect(existsSync(join(w.path, ".git/rebase-merge"))).toBe(true);
  writeFileSync(join(w.path, "stray.txt"), "half a write");
  const a = await w.open();
  expect((await a.list()).open.some((i) => i.title === "Third")).toBe(true);
  expect(clean(w.path)).toBe(true);
  expect(git(w.path, "rev-parse", "HEAD")).toBe(git(w.remote, "rev-parse", "main"));
});

test("intents: a bad file is reported, not touched", async () => {
  const bad = "---\nrepo: towercab\nu: 9\n---\n\n# Intent: Bad score\n";
  const fenced =
    "---\nrepo: towercab\n---\n\n# Intent: Fence\n\n## Problem\n- a\n```oops\n\n## Open questions\n- q?\n";
  const w = await world({
    "intents/261020-0721-good/intent.md": intentMd("towercab", "", "Good"),
    "intents/261020-0800-bad/intent.md": bad,
    "intents/261020-0900-a/intent.md": intentMd("towercab", "", "Dup A"),
    "done/261020-0900-b/intent.md": intentMd("towercab", "stage: done\n", "Dup B"),
    "intents/261019-1900-fine/intent.md": intentMd("towercab", "", "Fine"),
    "intents/261020-1000-fence/intent.md": fenced,
  });
  const l = await w.store.list();
  expect(ids(l.open)).toEqual(["261019-1900", "261020-0721"]);
  // A suffix resolves over open intents first: `900` is 261019-1900, not the bad 261020-0900.
  expect((await w.store.get("900")).title).toBe("Fine");
  await w.store.add({ repo: "towercab", title: "Trigger a write" }, NOW);
  expect(
    w
      .file("TODO.md")
      .endsWith(
        "## Can't read\n\n- done/261020-0900-b: duplicate id\n" +
          "- intents/261020-0800-bad/intent.md: u must be an integer 1-5\n- intents/261020-0900-a: duplicate id\n" +
          "- intents/261020-1000-fence/intent.md: unclosed code fence at line 9\n",
      ),
  ).toBe(true);
  expect(w.file("intents/261020-1000-fence/intent.md")).toBe(fenced);
  await expect(w.store.get("1000")).rejects.toThrow(
    "intents/261020-1000-fence/intent.md: unclosed code fence at line 9",
  );
  expect(w.file("DONE.md")).not.toContain("Dup B");
  expect(w.file("intents/261020-0800-bad/intent.md")).toBe(bad);
  const reason = new RefusedError("intents/261020-0800-bad/intent.md: u must be an integer 1-5");
  await expect(w.store.get("0800")).rejects.toThrow(reason);
  const head = w.head();
  await expect(w.store.update("0800", "touch", () => {})).rejects.toThrow(reason);
  expect(w.head()).toBe(head);
  await expect(w.store.get("0900")).rejects.toThrow("intents/261020-0900-a: duplicate id");
  await expect(w.store.get("261020-0900")).rejects.toThrow("intents/261020-0900-a: duplicate id");
  // Fixed by the owner → readable again.
  pushFiles(w.remote, { "intents/261020-0800-bad/intent.md": bad.replace("u: 9", "u: 2") }, "fix");
  expect((await w.store.get("0800")).u).toBe(2);
});

test("intents: store interface", async () => {
  const w = await world({ "intents/261020-0721-x/intent.md": intentMd("towercab", "u: 2\n", "X") });
  const s = w.store;
  expect(ids((await s.list()).open)).toEqual(["261020-0721"]);
  expect((await s.get("0721")).title).toBe("X");
  const added = await s.add({ repo: "towercab", title: "Y" }, NOW);
  expect(w.log()[0]).toBe(`towercab: add ${added.id}`);
  const up = await s.update(added.id, "rescore", (e) => e.setField("u", 5));
  expect(up.u).toBe(5);
  expect(w.log()[0]).toBe(`towercab: rescore ${added.id}`);
  // A marked update: the mark ends the commit as a trailer that hasMark finds.
  const mark = "Towercab-Entry: s 12";
  expect(await s.hasMark(mark)).toBe(false);
  await s.update(added.id, "spec", (e) => e.setField("stage", "spec"), mark);
  expect(git(w.remote, "log", "-1", "--format=%B", "main").trimEnd()).toBe(
    `towercab: spec ${added.id}\n\nTowercab-Entry: s 12`,
  );
  expect(await s.hasMark(mark)).toBe(true);
  expect(await s.hasMark("Towercab-Entry: s 1")).toBe(false);
  // Sections and answers go through the same write.
  const noted = await s.update(added.id, "answer", (e) => {
    e.setSection("Towercab", "Which DB?");
    e.addAnswer("postgres", new Date(2026, 9, 21, 10, 0));
  });
  expect(noted.sections.get("Answers")).toBe("- 2026-10-21 10:00: postgres");
  expect(w.file(`${up.dir}/intent.md`)).toMatch(
    /\n## Towercab\n\nWhich DB\?\n\n## Answers\n\n- 2026-10-21 10:00: postgres\n$/,
  );

  // A thrown error writes nothing; a change that changes nothing commits nothing.
  const head = w.head();
  await expect(
    s.update("0721", "nope", (e) => {
      e.setField("u", 1);
      throw new Error("not now");
    }),
  ).rejects.toThrow(new RefusedError("not now"));
  await s.update("0721", "noop", () => {});
  expect(w.head()).toBe(head);
  expect(clean(w.path)).toBe(true);
  await expect(s.get("zzz")).rejects.toThrow(new RefusedError("no open intent matches zzz"));

  // Two writers on one checkout (two stores, as two processes would be) run one after the other.
  const other = await w.open();
  const both = await Promise.all([
    s.add({ repo: "towercab", title: "W1" }, NOW),
    other.add({ repo: "towercab", title: "W2" }, NOW),
  ]);
  expect(both.map((i) => i.id).sort()).toEqual(["261021-0905-2", "261021-0905-3"]);
  for (const i of both) expect(w.has(`${i.dir}/intent.md`)).toBe(true);

  // GitHub: owner/name and the file's URL; a local remote has none.
  expect(s.github()).toBeNull();
  expect(s.url(up)).toBeNull();
  const gh = await w.open({ remote: "https://github.com/o/intents.git" });
  expect(gh.github()).toBe("o/intents");
  expect(gh.url(up)).toBe(`https://github.com/o/intents/blob/main/${up.dir}/intent.md`);

  // Pull and clone failures are SyncErrors; no remote and no checkout is refused.
  renameSync(w.remote, `${w.remote}.gone`);
  await expect(s.list()).rejects.toThrow(SyncError);
  await expect(s.list()).rejects.toThrow(/^pull failed: /);
  const fresh = join(tempDir(), "fresh");
  await expect(openStore({ remote: w.remote, path: fresh, tools: new FakeTools() })).rejects.toThrow(
    /^clone failed: /,
  );
  // A remote that looks like an option is a path to git, never an option.
  const marker = join(tempDir(), "ran");
  await expect(
    openStore({ remote: `--upload-pack=touch ${marker}`, path: fresh, tools: new FakeTools() }),
  ).rejects.toThrow(SyncError);
  expect(existsSync(marker)).toBe(false);
  await expect(openStore({ remote: "", path: fresh, tools: new FakeTools() })).rejects.toThrow(
    "does not exist",
  );
  mkdirSync(fresh);
  await expect(openStore({ remote: "", path: fresh, tools: new FakeTools() })).rejects.toThrow(
    "is not a git checkout",
  );

  // Git runs without prompts or hooks, as the author given.
  const tools = new FakeTools();
  const local = join(tempDir(), "local");
  mkdirSync(local);
  git(local, "init", "-q", "-b", "main");
  git(local, "commit", "-q", "--allow-empty", "-m", "start");
  mkdirSync(join(local, ".git/hooks"), { recursive: true });
  writeFileSync(join(local, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(local, ".git/hooks/pre-commit"), 0o755);
  // No `origin`: commits locally only.
  const bot = { name: "towercab[bot]", email: "1+towercab[bot]@users.noreply.github.com" };
  const ls = await openStore({ remote: "", path: local, tools, author: bot });
  const got = await ls.add({ repo: "towercab", title: "Local only" }, NOW);
  expect(git(local, "log", "-1", "--format=%s|%an|%ae").trim()).toBe(
    `towercab: add ${got.id}|${bot.name}|${bot.email}`,
  );
  expect(existsSync(join(local, "TODO.md")) && existsSync(join(local, "DONE.md"))).toBe(true);
  const call = tools.calls.find((c) => c.args.includes("commit"))!;
  expect(call.args).toContain("core.hooksPath=/dev/null");
  expect(call.opts.env?.GIT_TERMINAL_PROMPT).toBe("0");
});
