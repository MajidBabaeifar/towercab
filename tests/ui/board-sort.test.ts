// UI-146 to UI-149: the page's sort of the board's rows, from the keys the server gives.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BoardRepo } from "../../src/ui/view.ts";
import { readSort, SORT_STORAGE_KEY, type SortKey, sortRepos, writeSort } from "../../ui/src/board-sort.ts";

function repo(name: string, index: number, o: Partial<BoardRepo> = {}): BoardRepo {
  return {
    repo: name,
    github: "",
    waiting: 0,
    changedAt: null,
    index,
    open: 0,
    done: 0,
    proposed: 0,
    spend: { today: "", week: "", all: "" },
    cells: {},
    ...o,
  } as BoardRepo;
}

const ROWS = [
  repo("web", 0, { waiting: 1, open: 5, changedAt: "2026-10-26T21:00:00.000Z" }),
  repo("api", 1, { waiting: 2, open: 1, changedAt: "2026-10-26T19:00:00.000Z" }),
  repo("Docs", 2, { waiting: 1, open: 3, changedAt: "2026-10-26T22:00:00.000Z" }),
  repo("blog", 3),
  repo("crm", 4),
  repo("", 5, { waiting: 9, open: 9, changedAt: "2026-10-27T00:00:00.000Z" }),
];
const order = (key: SortKey) => sortRepos(ROWS, key).map((r) => r.repo);

test("ui: board sorts repos by the chosen order", () => {
  expect(order("needs")).toEqual(["api", "web", "Docs", "blog", "crm", ""]);
  expect(order("latest")).toEqual(["Docs", "web", "api", "blog", "crm", ""]);
  expect(order("todo")).toEqual(["web", "Docs", "api", "blog", "crm", ""]);
  expect(order("name")).toEqual(["api", "blog", "crm", "Docs", "web", ""]);
  expect(order("config")).toEqual(["web", "api", "Docs", "blog", "crm", ""]);
  // The input is not reordered.
  expect(ROWS.map((r) => r.repo)).toEqual(["web", "api", "Docs", "blog", "crm", ""]);
});

test("ui: board sort ties fall back to config order", () => {
  const flat = [repo("b", 1), repo("c", 2), repo("a", 0)];
  for (const key of ["needs", "latest", "todo", "config"] as const) {
    expect(sortRepos(flat, key).map((r) => r.repo)).toEqual(["a", "b", "c"]);
  }
  // The same keys give the same order whatever order the rows arrive in.
  expect(sortRepos([...ROWS].reverse(), "needs").map((r) => r.repo)).toEqual(order("needs"));
});

const store = new Map<string, string>();
beforeEach(() => store.clear());
afterEach(() => vi.unstubAllGlobals());

test("ui: board sort is remembered without storage failing", () => {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  expect(readSort()).toBe("needs");
  writeSort("name");
  expect(store.get(SORT_STORAGE_KEY)).toBe("name");
  expect(readSort()).toBe("name");
  store.set(SORT_STORAGE_KEY, "nonsense");
  expect(readSort()).toBe("needs");

  // Storage that throws on every read and write.
  const broken = () => {
    throw new Error("storage is disabled");
  };
  vi.stubGlobal("localStorage", { getItem: broken, setItem: broken });
  expect(readSort()).toBe("needs");
  expect(() => writeSort("latest")).not.toThrow();
  // No storage object at all.
  vi.stubGlobal("localStorage", undefined);
  expect(readSort()).toBe("needs");
  expect(() => writeSort("latest")).not.toThrow();
});
