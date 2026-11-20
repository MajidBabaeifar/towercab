import { expect, test } from "vitest";
import { MERGE_METHOD } from "../../src/forge.ts";
import { FakeForge } from "./fake-forge.ts";

test("fake forge: a merge pinned to a moved head is refused, and one pinned to the head merges", async () => {
  const f = new FakeForge();
  const n = (await f.openPr("o/web", { base: "main", head: "b", title: "t", body: "x" }))!;
  const head = (await f.mergeStatus("o/web", n)).head;
  expect((await f.mergePr("o/web", n, { method: MERGE_METHOD, head: "old" })).ok).toBe(false);
  expect((await f.mergePr("o/web", n, { method: MERGE_METHOD, head })).ok).toBe(true);
  expect((await f.mergeStatus("o/web", n)).state).toBe("MERGED");
  expect(f.calls.at(-1)).toBe(`merge o/web#${n} squash head=${head}`);
});

test("fake forge: a second open PR on one branch is refused", async () => {
  const f = new FakeForge();
  await f.openPr("o/web", { base: "main", head: "b", title: "t", body: "" });
  await expect(f.openPr("o/web", { base: "main", head: "b", title: "t", body: "" })).rejects.toThrow(
    "already exists",
  );
});

test("forge: FakeForge records calls and answers from setup", async () => {
  const f = new FakeForge();
  f.files.set("o/web:TOWERCAB.md", "text");
  f.jobLogs.set(7, "job log");
  const n = (await f.openPr("o/web", { base: "main", head: "b", title: "t", body: "x" }))!;
  await f.updatePrBody("o/web", n, "new");
  await f.upsertPrComment("o/web", n, "<!-- m -->", "<!-- m -->\none");
  const edited = await f.upsertPrComment("o/web", n, "<!-- m -->", "<!-- m -->\ntwo");
  await f.requestReviewers("o/web", n, ["carol"]);
  expect(edited).toEqual({ edited: true });
  expect(await f.readFile("o/web", "TOWERCAB.md", "main")).toBe("text");
  expect(await f.jobLog("o/web", 7)).toBe("job log");
  expect((await f.readPr("o/web", n)).comments.map((c) => c.body)).toEqual(["<!-- m -->\ntwo"]);
  expect((await f.prsOnBranch("o/web", "b")).map((p) => p.state)).toEqual(["OPEN"]);
  expect(f.calls).toEqual([
    `open o/web#${n} b`,
    `body o/web#${n}`,
    `comment o/web#${n}`,
    `edit-comment o/web#${n}`,
    `request-review o/web#${n} carol`,
  ]);
});

test("forge: FakeForge fails a method on request", async () => {
  const f = new FakeForge();
  f.failNext("openPrBranches", 2, "HTTP 502");
  await expect(f.openPrBranches("o/web")).rejects.toThrow("HTTP 502");
  await expect(f.openPrBranches("o/web")).rejects.toThrow("HTTP 502");
  expect(await f.openPrBranches("o/web")).toEqual([]);
  expect(f.calls).toEqual(["openPrBranches failed", "openPrBranches failed"]);
});
