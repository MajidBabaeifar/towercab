import { expect, test } from "vitest";
import type { IntentStore, Listing } from "../../src/intents/types.ts";
import { listCache } from "../../src/ui/list-cache.ts";

test("ui: pages read the intents list through a short cache", async () => {
  let reads = 0;
  let t = 0;
  const listing = { open: [], done: [] } as unknown as Listing;
  const store = {
    list: async () => {
      reads++;
      return listing;
    },
    update: async () => null,
  } as unknown as IntentStore;
  const c = listCache(store, 5, () => t);
  await Promise.all([c.list(), c.list()]);
  expect(reads).toBe(1);
  t = 3;
  await c.list();
  expect(reads).toBe(1);
  t = 6;
  await c.list();
  expect(reads).toBe(2);
  await c.update("x", "w", () => {});
  await c.list();
  expect(reads).toBe(3);
});
