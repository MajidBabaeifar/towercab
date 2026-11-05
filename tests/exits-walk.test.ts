import { expect, test } from "vitest";
import { apply, EXITS, exitEvent, exitsOf, finished, WAITS, waitInfo } from "../src/machine.ts";
import { exitsWorld } from "./helpers/exits.ts";

const text = (key: string) =>
  key === "crashed at" ? "crashed at build" : key === "bad after:" ? "bad after: 261001-0800" : key;

test("machine: every wait has an exit besides a reply that ends or moves the intent", () => {
  expect(Object.keys(EXITS).sort()).toEqual(Object.keys(WAITS).sort());
  for (const key of Object.keys(WAITS)) {
    const waiting = text(key);
    const stage = waitInfo(waiting).stage;
    const moved: string[] = [];
    for (const e of exitsOf(waiting)) {
      if (e.do === "continue") continue;
      const w = exitsWorld();
      w.set({ stage, waiting, from_stage: stage === "steps" ? null : "build", head: "abc" });
      const before = w.m;
      const steps = [{ n: 1, when: "after", text: "do it", why: "", done_at: null }];
      const out = apply(w.cx, before, { event: exitEvent(e.do as never, stage), data: { steps } });
      if (out.id !== before.id || out.stage !== before.stage || finished(out.stage)) moved.push(e.do);
    }
    expect(moved.length, `${key} has no exit besides a reply that moves the intent`).toBeGreaterThan(0);
  }
});
