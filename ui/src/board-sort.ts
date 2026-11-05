// The board's sort (UI-146 to UI-149): the page only orders rows by the keys the server gives (UI-147).

import type { BoardRepo } from "../../src/ui/view.ts";

export type SortKey = "needs" | "latest" | "todo" | "name" | "config";

export const SORTS: { key: SortKey; label: string }[] = [
  { key: "needs", label: "Needs you" },
  { key: "latest", label: "Latest change" },
  { key: "todo", label: "Most to do" },
  { key: "name", label: "Name" },
  { key: "config", label: "Config order" },
];

export const SORT_STORAGE_KEY = "towercab.board.sort";

export function sortLabel(key: SortKey): string {
  return SORTS.find((s) => s.key === key)?.label ?? "Needs you";
}

/** A missing, unknown or unreadable value means "Needs you". */
export function readSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_STORAGE_KEY);
    return SORTS.find((s) => s.key === v)?.key ?? "needs";
  } catch {
    return "needs";
  }
}

export function writeSort(key: SortKey): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, key);
  } catch {
    // No storage: the sort applies until the page reloads.
  }
}

/** A copy of the rows in the chosen order; ties keep config order (`index`), "Unknown repo" stays last. */
export function sortRepos(repos: BoardRepo[], key: SortKey): BoardRepo[] {
  const time = (r: BoardRepo) => (r.changedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(r.changedAt));
  const by: (a: BoardRepo, b: BoardRepo) => number = {
    needs: (a: BoardRepo, b: BoardRepo) => b.waiting - a.waiting,
    latest: (a: BoardRepo, b: BoardRepo) => {
      const d = time(b) - time(a);
      return Number.isNaN(d) ? 0 : d;
    },
    todo: (a: BoardRepo, b: BoardRepo) => b.open - a.open,
    name: (a: BoardRepo, b: BoardRepo) => a.repo.toLowerCase().localeCompare(b.repo.toLowerCase(), "en"),
    config: () => 0,
  }[key];
  return [...repos].sort((a, b) => {
    if ((a.repo === "") !== (b.repo === "")) return a.repo === "" ? 1 : -1;
    return by(a, b) || a.index - b.index;
  });
}
