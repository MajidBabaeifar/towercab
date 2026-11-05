// UI-191: which Needs you cards are folded, remembered in this browser.

import type { Card } from "../../src/ui/view.ts";

const FOLD_KEY = "towercab.needs.folded";

/** Intent id → the key of the wait it was folded on, mirrored in `localStorage` when there is one. */
let foldedCards: Map<string, string> | null = null;

function folds(): Map<string, string> {
  if (foldedCards) return foldedCards;
  foldedCards = new Map();
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [id, k] of Object.entries(v)) if (typeof k === "string") foldedCards.set(id, k);
    }
  } catch {
    // No storage, or not JSON: start with nothing folded.
  }
  return foldedCards;
}

function save(): void {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(Object.fromEntries(folds())));
  } catch {
    // No storage: the card stays folded until the page reloads.
  }
}

/** What a card waits on; a new ask or a new round gives a different key. */
export const waitKey = (c: Pick<Card, "kind" | "pr" | "ask" | "question">): string =>
  JSON.stringify([c.kind, c.pr?.number ?? null, c.ask, c.question?.question ?? null]);

/** The wait key the card was folded on, if any. */
export const foldedOn = (id: string): string | undefined => folds().get(id);

export function setFolded(id: string, key: string, folded: boolean): void {
  if (folded) folds().set(id, key);
  else folds().delete(id);
  save();
}

/** Drops the fold of an intent whose wait changed. */
export function forgetFold(id: string): void {
  setFolded(id, "", false);
}

/** Drops the folds of intents that no longer wait. */
export function pruneFolds(waiting: string[]): void {
  const map = folds();
  let changed = false;
  for (const id of [...map.keys()]) {
    if (!waiting.includes(id)) {
      map.delete(id);
      changed = true;
    }
  }
  if (changed) save();
}
