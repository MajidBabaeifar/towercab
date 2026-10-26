// IDs, slugs, folder names, suffixes (INT-3). The store's side of IDs is in store.test.ts.

import { expect, test } from "vitest";
import { dirId, newId, resolve, slugOf, sortKey, splitDir } from "../../src/intents/id.ts";

test("intents: IDs are never reused", () => {
  const at = new Date(2026, 9, 21, 9, 5, 59);
  expect(newId(at, new Set())).toBe("261021-0905");
  expect(newId(at, new Set(["261021-0905"]))).toBe("261021-0905-2");
  expect(newId(at, new Set(["261021-0905", "261021-0905-2"]))).toBe("261021-0905-3");
  expect(newId(at, new Set(["261021-0905-2"]))).toBe("261021-0905");
  expect(sortKey("261021-0905")).toEqual([261021, 905, 1]);
  expect(sortKey("261021-0905-12")).toEqual([261021, 905, 12]);
  // A folder that isn't `<id>-<slug>` still takes its ID.
  expect(dirId("261021-0905-Bad_Slug")).toBe("261021-0905");
  expect(dirId("261021-0905-2")).toBe("261021-0905-2");
  expect(dirId("261021-0905-2x")).toBe("261021-0905");
  expect(dirId("261021-09050")).toBeNull();
  expect(dirId("notes")).toBeNull();
});

test("intents: a unique suffix resolves", () => {
  const ids = ["261020-0721", "261020-0721-2", "261020-0721-12", "261019-1100"];
  expect(resolve("261020-0721", ids)).toBe("261020-0721");
  expect(resolve("1100", ids)).toBe("261019-1100");
  expect(resolve("-2", ids)).toBe("261020-0721-2");
  expect(resolve("0721", ids)).toBe("261020-0721");
  expect(() => resolve("2", ids)).toThrow("2 matches 2 intents: 261020-0721-12, 261020-0721-2");
  expect(() => resolve("9999", ids)).toThrow("no open intent matches 9999");
  expect(() => resolve("", ids)).toThrow("no open intent matches ");
});

test("intents: slug rules", () => {
  for (const [title, want] of [
    ["Rust crate and intent store", "rust-crate-and-intent-store"],
    ["Don't break: Bob’s API!", "dont-break-bobs-api"],
    ["  --Hello__World--  ", "hello-world"],
    ["2fa for login", "n2fa-for-login"],
    ["1", "n1"],
    ["Ünïcödé", "n-c-d"],
    ["", "intent"],
    ["!!! ???", "intent"],
    ["Repo files, protected paths and `towercab protect`", "repo-files-protected-paths-and-towercab-protect"],
  ]) {
    expect(slugOf(title!), title).toBe(want);
  }
  expect(slugOf(`${"a".repeat(47)} b`)).toBe("a".repeat(47));
  expect(slugOf("word ".repeat(30)).length).toBeLessThanOrEqual(48);
  expect(splitDir("261020-0721-2-priority-order")).toEqual({ id: "261020-0721-2", slug: "priority-order" });
  expect(splitDir("261020-0721-rust-crate")).toEqual({ id: "261020-0721", slug: "rust-crate" });
  for (const bad of ["261020-0721-2", "261020-0721", "notes", "261020-0721-Upper", "26102-0721-x"]) {
    expect(splitDir(bad), bad).toBeNull();
  }
  for (const title of ["2fa for login", "42", "plain", "x-2-y"]) {
    for (const id of ["261020-0721", "261020-0721-3"]) {
      expect(splitDir(`${id}-${slugOf(title)}`)).toEqual({ id, slug: slugOf(title) });
    }
  }
});
