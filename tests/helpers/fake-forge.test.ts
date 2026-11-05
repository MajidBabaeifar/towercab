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
