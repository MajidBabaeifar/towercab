// A mission that asked for a slot and then moved on without a run stops asking (LOOP-111).

import { join } from "node:path";
import { expect, test } from "vitest";
import type { Handler, Handlers } from "../src/handlers.ts";
import { ORDER, ok, wait } from "../src/machine.ts";
import type { Mission } from "../src/mission.ts";
import type { ChildExit, ChildSpec } from "../src/tools.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";

const A = "261026-1000";
const B = "261026-1001";
const C = "261026-1002";

const byIntent = (p: Pipe, id: string) =>
  p.db.all<Mission>("SELECT * FROM missions WHERE intent = ? ORDER BY id", id);
const stageOf = (p: Pipe, id: string) => byIntent(p, id)[0]?.stage;
const dataOfIntent = (p: Pipe, id: string) => JSON.parse(byIntent(p, id)[0]!.data) as Record<string, unknown>;
const approvePlan = (p: Pipe, id: string) => p.loop.move(byIntent(p, id)[0]!, { event: "plan_merged" });

async function pass(p: Pipe, n = 1) {
  for (let i = 0; i < n; i++) {
    await p.loop.pass();
    p.clock.advance(61);
  }
}

test("loop: a returning mark ends when the mission moves on without a run", async () => {
  const p = new Pipe(
    TARGET,
    Object.fromEntries(
      [A, B, C].map((id) => [
        `intents/${id}-t${id.slice(-1)}/intent.md`,
        intent({ title: `T${id.slice(-1)}`, repo: "web", u: 4, i: 4, extra: "" }),
      ]),
    ),
  );
  let end!: (e: ChildExit) => void;
  p.tools.child("review", () => new Promise<ChildExit>((r) => (end = r)));
  const dir = p.home.runs("children");
  const spec: ChildSpec = {
    kind: "review",
    argv: ["review"],
    cwd: dir,
    env: {},
    stdout: join(dir, "review.out"),
    stderr: join(dir, "review.err"),
    slot: true,
  };
  let go = false;
  const h: Handler = {
    step: async (_cx, m) => {
      if (m.stage === "pick" || m.stage === "design") return { done: ok() };
      if (m.stage === "plan") return { done: wait("approve plan") };
      if (m.stage === "build") return m.intent === A ? { done: ok() } : { poll: 3600 };
      if (m.stage === "ci") return go ? { done: ok() } : { poll: 120 };
      if (m.stage === "review") return { spawn: spec };
      return { done: ok() };
    },
    finish: async () => ({ done: ok() }),
  };
  const handlers: Handlers = Object.fromEntries(ORDER.filter((s) => s !== "done").map((s) => [s, h]));
  await p.start({ repos: { web: { github: "owner/web", ahead: 8 } } }, { handlers });
  await pass(p, 8);
  approvePlan(p, A);
  await pass(p, 6);
  approvePlan(p, B);
  await pass(p, 3);
  go = true;
  await pass(p, 8);
  // B holds the only slot, so A's review run waits for it.
  expect(dataOfIntent(p, A).returning).toBeTypeOf("number");
  // A stops to wait for the owner's merge instead: it no longer asks for a slot.
  p.loop.move(byIntent(p, A)[0]!, wait("review and merge PR"));
  expect(stageOf(p, A)).toBe("approval:merge");
  expect(dataOfIntent(p, A).returning).toBeUndefined();
  approvePlan(p, C);
  await pass(p, 3);
  expect(stageOf(p, C)).toBe("approval:plan");
  // B ends: the free slot goes to the ready intent, not to a stale mark.
  p.loop.move(byIntent(p, B)[0]!, { event: "code_merged", set: { merge_sha: "abc", merged_by: "owner" } });
  await pass(p, 4);
  expect(stageOf(p, C)).toBe("build");
  end?.({ code: 0, signal: null });
});
