// A body that doesn't parse (INT-30): the intent is unreadable, so no design run starts on empty sections.

import { afterAll, beforeAll, expect, test } from "vitest";
import { DESIGN, DIR, ID, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ body: "```oops, never closed\n\n## Open questions\n- q?\n" })), {
    keep: true,
  });
  p.queue("design", reply(DESIGN));
  await p.start();
}, 30_000);

afterAll(() => p.cleanup());

test("pipeline: a broken body fails design with its reason", async () => {
  await p.until(() => p.mission() !== undefined, 3);
  expect(p.mission()).toBeUndefined();
  expect(p.claudeCalls).toEqual([]);
  const l = await p.store.list();
  expect(l.open).toEqual([]);
  expect(l.unreadable).toMatchObject([
    { path: `${DIR}/intent.md`, reason: "unclosed code fence at line 16", id: ID },
  ]);
  await expect(p.store.get(ID)).rejects.toThrow(`${DIR}/intent.md: unclosed code fence at line 16`);
});
