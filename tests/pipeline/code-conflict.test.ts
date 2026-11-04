// A code PR that conflicts with its base gets conflict rounds by itself, two at most, before the owner
// is asked (PIP-134).

import { expect, test } from "vitest";
import { happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const gates = (p: Pipe) =>
  p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transitions WHERE to_stage = 'gate'")!.n;
const conflicts = (p: Pipe) =>
  p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM transitions WHERE event = 'conflict'")!.n;

async function atGate(): Promise<Pipe> {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  await p.start();
  await p.until(() => gates(p) === 1);
  return p;
}

test("pipeline: a code PR in conflict is resolved without asking", async () => {
  const p = await atGate();
  try {
    p.prNo("web", p.mission()!.pr!).mergeStates.push("DIRTY");
    await p.until(() => p.mission()?.stage === "done");
    expect(p.mission()!.stage, p.moves()).toBe("done");
    expect(conflicts(p)).toBe(1);
    expect(p.stages(p.mission()!.id)).not.toContain("blocked");
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: a code conflict that stays after two rounds asks the owner", async () => {
  const p = await atGate();
  try {
    p.prNo("web", p.mission()!.pr!).mergeStates.push("DIRTY", "DIRTY", "DIRTY");
    const blocked = await p.untilStage("blocked");
    expect(blocked.waiting).toBe("merge failed");
    expect(blocked.why).toContain("still conflicts");
    expect(conflicts(p)).toBe(2);
    expect(JSON.parse(blocked.data).conflictRounds.n).toBe(2);
    expect(JSON.parse(blocked.data).reviewFixes ?? 0).toBe(0);
    // It stays asked: later reads of a conflicting PR don't start a third round.
    p.prNo("web", blocked.pr!).mergeable = "CONFLICTING";
    await p.until(() => false, 5);
    expect(p.mission()!.stage).toBe("blocked");
    expect(conflicts(p)).toBe(2);
  } finally {
    p.cleanup();
  }
}, 120_000);
