// UI-189 to UI-191: the remembered folds of the Needs you cards (the browser side is in ui/needs-fold.spec.ts).

import { beforeEach, expect, test, vi } from "vitest";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.resetModules();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});

const load = () => import("../../ui/src/folds.ts");
const card = { kind: "question", pr: null, ask: "Answer the question", question: null } as const;

test("ui: needs-you folds are kept per intent in localStorage", async () => {
  const f = await load();
  const key = f.waitKey(card);
  f.setFolded("a", key, true);
  expect(JSON.parse(store.get("towercab.needs.folded") ?? "")).toEqual({ a: key });
  vi.resetModules();
  expect((await load()).foldedOn("a")).toBe(key);
  (await load()).setFolded("a", key, false);
  expect(JSON.parse(store.get("towercab.needs.folded") ?? "")).toEqual({});
});

test("ui: a new ask or round gives a card a new wait key", async () => {
  const { waitKey } = await load();
  const base = waitKey(card);
  expect(waitKey({ ...card })).toBe(base);
  expect(waitKey({ ...card, ask: "Merge the plan" })).not.toBe(base);
  expect(waitKey({ ...card, pr: { number: 7, url: "", label: "PR" } })).not.toBe(base);
  expect(waitKey({ ...card, kind: "plan" })).not.toBe(base);
});

test("ui: folds of intents that no longer wait are forgotten", async () => {
  const f = await load();
  f.setFolded("a", "k", true);
  f.setFolded("b", "k", true);
  f.pruneFolds(["b"]);
  expect(JSON.parse(store.get("towercab.needs.folded") ?? "")).toEqual({ b: "k" });
});

test("ui: folds work without storage", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("storage is off");
    },
    setItem: () => {
      throw new Error("storage is off");
    },
  });
  const f = await load();
  f.setFolded("a", "k", true);
  expect(f.foldedOn("a")).toBe("k");
});
