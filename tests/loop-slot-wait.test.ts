// A run asked for while every slot is taken stamps its wait, once, and nothing else does (LOOP-104).

import { join } from "node:path";
import { expect, test } from "vitest";
import type { Ctx, Handler, Handlers, Progress } from "../src/handlers.ts";
import { ORDER, ok, wait } from "../src/machine.ts";
import { dataOf, type Mission } from "../src/mission.ts";
import type { ChildExit, ChildSpec } from "../src/tools.ts";
import { intent, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";

const A = "261026-1000";
const B = "261026-1001";
const C = "261026-1002";

const REPOS = { web: { github: "owner/web" }, api: { github: "owner/api" }, docs: { github: "owner/docs" } };

function fake(step: (m: Mission, cx: Ctx) => Progress): Handlers {
  const h: Handler = { step: async (cx, m) => step(m, cx), finish: async () => ({ done: ok() }) };
  return Object.fromEntries(ORDER.filter((s) => s !== "done").map((s) => [s, h]));
}

function child(p: Pipe, kind: string) {
  let end!: (e: ChildExit) => void;
  const done = new Promise<ChildExit>((r) => {
    end = r;
  });
  p.tools.child(kind, () => done);
  const dir = p.home.runs("children");
  const spec: ChildSpec = {
    kind,
    argv: [kind],
    cwd: dir,
    env: {},
    stdout: join(dir, `${kind}.out`),
    stderr: join(dir, `${kind}.err`),
    slot: true,
  };
  return { spec, end: () => end({ code: 0, signal: null }) };
}

const file = (id: string, repo: string, u: number, i: number) => [
  `intents/${id}-t${id.slice(-1)}/intent.md`,
  intent({ title: `T${id.slice(-1)}`, repo, u, i, extra: "" }),
];

const byIntent = (p: Pipe, id: string) =>
  p.db.all<Mission>("SELECT * FROM missions WHERE intent = ? ORDER BY id", id)[0] as Mission;

async function pass(p: Pipe, seconds = 61) {
  await p.loop.pass();
  p.clock.advance(seconds);
}

test("loop: only waiting for a slot stamps the wait", async () => {
  const p = new Pipe(
    TARGET,
    Object.fromEntries([file(A, "web", 5, 5), file(C, "docs", 4, 4), file(B, "api", 3, 3)] as [
      string,
      string,
    ][]),
  );
  const a = child(p, "a-work");
  const b = child(p, "b-work");
  let go = false;
  await p.start(
    { repos: REPOS },
    {
      handlers: fake((m) => {
        if (m.intent === C) return { done: wait("approve spec") };
        if (m.intent === B) return { spawn: b.spec };
        return go ? { spawn: a.spec } : { poll: 30 };
      }),
    },
  );
  // A polls, C waits on the owner, B's run takes the only slot.
  while (byIntent(p, B)?.child_kind !== "b-work") await pass(p);
  await pass(p);
  const stamped = (id: string) => dataOf(byIntent(p, id)).slot_wait_since;
  expect([stamped(A), stamped(B), stamped(C)]).toEqual([undefined, undefined, undefined]);

  // A's run is asked for while the slot is taken: only A is stamped.
  go = true;
  await pass(p);
  const since = stamped(A);
  expect(typeof since).toBe("number");
  expect([stamped(B), stamped(C)]).toEqual([undefined, undefined]);
  expect(byIntent(p, C).waiting).not.toBeNull();

  // Asked for again, the stamp stays the first one.
  await pass(p);
  expect(stamped(A)).toBe(since);

  // When the slot frees and the run starts, the stamp is gone.
  b.end();
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 5 && byIntent(p, A).child_kind !== "a-work"; i++) await pass(p);
  expect(byIntent(p, A).child_kind).toBe("a-work");
  expect(dataOf(byIntent(p, A))).not.toHaveProperty("slot_wait_since");
  expect(dataOf(byIntent(p, A))).not.toHaveProperty("slot_wait_step");
  a.end();
});
