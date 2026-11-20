// LOOP-152: the running version and the release that waits, as `towercab status` shows them.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { versionLine } from "../src/status.ts";
import { version } from "../src/update.ts";
import { FakeTools } from "./helpers/tools.ts";
import { bareRepo, git, tempDir } from "./helpers/world.ts";

function installed() {
  const bare = bareRepo({ "src/a.ts": "1\n" });
  const checkout = join(tempDir(), "towercab");
  git(tempDir(), "clone", "-q", bare, checkout);
  return { bare, checkout };
}

function release(bare: string, tag: string): void {
  const w = join(tempDir("tc-rel-"), "w");
  git(dirname(w), "clone", "-q", bare, w);
  mkdirSync(join(w, "src"), { recursive: true });
  writeFileSync(join(w, "src/a.ts"), `${tag}\n`);
  git(w, "commit", "-q", "-am", tag);
  git(w, "push", "-q", "origin", "main");
  git(w, "tag", tag);
  git(w, "push", "-q", "origin", tag);
}

const fetchAll = (checkout: string) => git(checkout, "fetch", "-q", "--tags", "origin");

test("status: shows the running version on a tag", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.1.0");
  fetchAll(checkout);
  git(checkout, "checkout", "-q", "--detach", "v1.1.0");
  const v = await version({ tools: new FakeTools(), checkout });
  expect(v.name).toBe("v1.1.0");
  expect(versionLine(v, "0.5.0").version).toBe(`0.5.0 (v1.1.0, ${v.commit})`);
});

test("status: shows the version past a tag with the commit", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.1.0");
  git(checkout, "pull", "-q", "--ff-only");
  writeFileSync(join(checkout, "src/a.ts"), "later\n");
  git(checkout, "commit", "-q", "-am", "later");
  const v = await version({ tools: new FakeTools(), checkout });
  expect(v.name).toBe(`v1.1.0-1-g${v.commit}`);
  expect(versionLine(v, "0.5.0").version).toBe(`0.5.0 (v1.1.0-1-g${v.commit}, ${v.commit})`);
});

test("status: shows the commit when there are no tags", async () => {
  const { checkout } = installed();
  const v = await version({ tools: new FakeTools(), checkout });
  expect(v.name).toBe(v.commit);
  expect(versionLine(v, "0.5.0")).toEqual({ version: `0.5.0 (${v.commit})`, update: null });
});

test("status: release channel says a newer release is available", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.0.0");
  fetchAll(checkout);
  git(checkout, "checkout", "-q", "--detach", "v1.0.0");
  release(bare, "v1.1.0");
  release(bare, "v1.2.0-rc1");
  fetchAll(checkout);
  const v = await version({ tools: new FakeTools(), checkout, channel: "release" });
  expect(v.release).toEqual({ running: "v1.0.0", available: "v1.1.0" });
  expect(versionLine(v, "0.5.0").update).toBe("update: v1.1.0 is available");
});

test("status: release channel says up to date", async () => {
  const { bare, checkout } = installed();
  release(bare, "v1.0.0");
  fetchAll(checkout);
  git(checkout, "checkout", "-q", "--detach", "v1.0.0");
  const v = await version({ tools: new FakeTools(), checkout, channel: "release" });
  expect(v.release).toEqual({ running: "v1.0.0", available: null });
  expect(versionLine(v, "0.5.0").update).toBe("up to date");
});
