// UI-250: "Up next" says a reason that every row shares once, above the list.

import type { UpNextView } from "../../src/ui/view.ts";

/** The reason all of two or more rows share; null when they differ, one row stands alone, or a row has none. */
export function sharedReason(items: Pick<UpNextView, "reason">[]): string | null {
  if (items.length < 2) return null;
  const first = items[0]!.reason;
  return first && items.every((u) => u.reason === first) ? first : null;
}
