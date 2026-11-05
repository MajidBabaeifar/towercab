import { expect, test } from "vitest";
import { exitsOf } from "../../src/machine.ts";
import { exitsWorld } from "../helpers/exits.ts";

test("pipeline: a code change waiting for its steps cannot be marked done", () => {
  // A merged code change still deploys: the owner's `done` is not an exit there, and the event is ignored.
  const w = exitsWorld();
  w.set({ stage: "steps", waiting: "your steps" });
  expect(exitsOf("your steps", false, true).map((e) => e.do)).toEqual(["tick", "retry", "drop"]);
  expect(w.move({ event: "owner_done" }).stage).toBe("steps");
  // A steps delivery may end it.
  const s = exitsWorld();
  s.set({ stage: "steps", waiting: "your steps" });
  expect(exitsOf("your steps", false, false).map((e) => e.do)).toContain("done");
  expect(s.move({ event: "owner_done", data: { delivery: "steps" } }).stage).toBe("done");
});
