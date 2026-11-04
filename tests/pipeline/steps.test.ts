// The owner's steps and the end of a change (SHIP-17..22): the plan lists what only the owner can do,
// steps needed before the merge hold it, steps needed after it make the change wait at `steps`, and a
// change is done only after its steps and a green live check; without a live check it ends unverified.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { tickSteps } from "../../src/commands.ts";
import { dataOf, type Mission } from "../../src/mission.ts";
import {
  build,
  DIR,
  happy,
  ID,
  intent,
  intents,
  NONE_LIVE,
  PLAN,
  REVIEW,
  reply,
  TARGET,
} from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const BEFORE = {
  when: "before",
  text: "add the `NPM_TOKEN` secret to the repo",
  why: "the release needs it",
};
const AFTER = { when: "after", text: "run the server apply", why: "the server needs the new settings" };
const PLAN_MD = `${DIR}/plan.md`;

const moves = (p: Pipe) =>
  p.db.all<{ from_stage: string; event: string; to_stage: string }>(
    "SELECT from_stage, event, to_stage FROM transitions ORDER BY id",
  );
// The stages entered in order; a wait at `steps` enters it again, which is no new stage.
const path = (p: Pipe) =>
  moves(p)
    .map((t) => t.to_stage)
    .filter((s, i, all) => s !== all[i - 1]);
const planFile = (p: Pipe) => {
  try {
    return p.show("intents", "main", PLAN_MD);
  } catch {
    return p.show("intents", "main", PLAN_MD.replace("intents/", "done/"));
  }
};
const intentFile = (p: Pipe) => {
  for (const base of ["intents", "done"]) {
    try {
      return p.show("intents", "main", `${base}/${ID}-show-a-greeting/intent.md`);
    } catch {
      // The other folder.
    }
  }
  throw new Error("no intent file");
};
const outbox = (p: Pipe) =>
  p.db.all<{ text: string }>("SELECT text FROM outbox ORDER BY created, key").map((r) => r.text);
const tick = (p: Pipe, ns: number[] | "all", done = true) =>
  tickSteps(p.db, ID, ns, done, new Date(p.clock.now() * 1000));
const steps = (p: Pipe) =>
  (dataOf(p.mission()!) as { steps?: { n: number; when: string; done_at: string | null }[] }).steps ?? [];
const waitingOn = (p: Pipe, waiting: string) => () => {
  const m = p.mission();
  return m?.waiting === waiting && m.step !== "enter";
};

function world(plan: Record<string, unknown>, a = 5): Pipe {
  const p = new Pipe(TARGET, intents(intent({ a })), { keep: true });
  happy(p);
  p.respond.plan = reply({ ...PLAN, ...plan });
  return p;
}

describe("ship: owner steps before and after the merge", () => {
  let p: Pipe;
  let held: Mission;

  beforeAll(async () => {
    p = world({ owner_steps: [BEFORE, AFTER], live_none_why: NONE_LIVE });
    await p.start();
    await p.until(waitingOn(p, "your steps first"));
    held = p.mission()!;
  }, 60_000);

  afterAll(() => p.cleanup());

  test("ship: the plan lists owner steps", () => {
    const md = planFile(p);
    expect(md).toContain(
      "## Your steps\n\n- [ ] before merge: add the `NPM_TOKEN` secret to the repo (the release needs it)\n" +
        "- [ ] after merge: run the server apply (the server needs the new settings)\n",
    );
    // The section follows `## Access`, then the claim line.
    expect(md.indexOf("## Access")).toBeLessThan(md.indexOf("## Your steps"));
    expect(md).toContain(`Nothing to check live: ${NONE_LIVE}`);
  });

  test("ship: steps are read from the merged plan", () => {
    const d = dataOf(held) as { steps: unknown[]; liveNoneWhy: string };
    expect(d.steps).toEqual([
      { n: 1, when: "before", text: BEFORE.text, why: BEFORE.why, done_at: null },
      { n: 2, when: "after", text: AFTER.text, why: AFTER.why, done_at: null },
    ]);
    expect(d.liveNoneWhy).toBe(NONE_LIVE);
  });

  test("ship: the gate waits for steps before the merge", () => {
    // a5 would merge on its own; the open step holds it, with the checklist as the why.
    expect([held.stage, held.from_stage, held.waiting]).toEqual(["blocked", "gate", "your steps first"]);
    expect(held.why).toBe(`1. ${BEFORE.text} (${BEFORE.why})`);
    expect(p.prNo("web", held.pr!).state).toBe("OPEN");
    expect(path(p)).not.toContain("approval:merge");
    expect(path(p)).not.toContain("merge");
    const msg = outbox(p).find((t) => t.includes("Do these before this change merges"))!;
    expect(msg).toContain(BEFORE.text);
    // The intent file shows what is open.
    expect(intentFile(p)).toMatch(/steps_left: 1 of 1\nwaiting: your steps first/);
  });

  test("ship: ticking the last step continues the gate", async () => {
    expect(tick(p, [1])).toContain(`steps left: 2. ${AFTER.text}`);
    // The tick is stored with its time, and the plan file gets it on the next pass.
    expect(steps(p)[0]!.done_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    await p.until(() => p.mission()!.stage === "steps" && p.mission()!.step !== "enter");
    const t = moves(p);
    expect(t).toContainEqual({ from_stage: "blocked", event: "answered", to_stage: "gate" });
    expect(t).toContainEqual({ from_stage: "merge", event: "code_merged", to_stage: "steps" });
    expect(p.prNo("web", p.mission()!.pr!).state).toBe("MERGED");
  }, 60_000);

  test("ship: merge goes to your steps when the plan has after steps", async () => {
    const m = p.mission()!;
    expect([m.stage, m.waiting]).toEqual(["steps", "your steps"]);
    expect(m.why).toBe(`2. ${AFTER.text} (${AFTER.why})`);
    expect(outbox(p).some((t) => t.includes("Do these so the change works live"))).toBe(true);
    // Nothing is deployed or applied meanwhile: the stage only waits.
    await p.until(() => false, 3);
    expect(p.mission()!.stage).toBe("steps");
    expect(path(p)).not.toContain("deploy");
    expect(intentFile(p)).toMatch(/steps_left: 1 of 1\nwaiting: your steps\n/);
  });

  test("ship: ticks are written to plan.md", () => {
    expect(planFile(p)).toMatch(
      /- \[x\] before merge: add the `NPM_TOKEN` secret to the repo \(the release needs it\) · ticked \d{4}-\d\d-\d\dT[\d:]+[+-]\d\d:\d\d\n- \[ \] after merge:/,
    );
  });

  test("ship: ticks survive a rebuilt database", async () => {
    // The database forgets the steps; the plan file has the tick, so it comes back from there.
    p.db.run("UPDATE missions SET data = json_remove(data, '$.steps') WHERE id = ?", p.mission()!.id);
    expect(steps(p)).toEqual([]);
    await p.until(() => steps(p).length === 2);
    expect(steps(p).map((s) => s.done_at !== null)).toEqual([true, false]);
    expect(p.mission()!.stage).toBe("steps");
  });

  test("ship: done only after steps, deploy and e2e", async () => {
    tick(p, [2]);
    // No live block here, but the plan claims nothing to check: steps, then deploy skipped, then done.
    await p.untilStage("done");
    expect(path(p).slice(-4)).toEqual(["merge", "steps", "deploy", "done"]);
    expect(moves(p).at(-1)).toEqual({ from_stage: "deploy", event: "skip", to_stage: "done" });
  });
});

describe("ship: ticks outside the wait", () => {
  test("ship: ticks outside the wait are kept", async () => {
    const p = world({ owner_steps: [BEFORE, AFTER], live_none_why: NONE_LIVE });
    await p.start();
    try {
      await p.until(waitingOn(p, "your steps first"));
      // The after step is ticked early, while the mission waits on the before step.
      expect(() => tick(p, [9])).toThrow(`step 9 isn't one of ${ID}'s steps`);
      tick(p, [2]);
      expect(p.mission()!.waiting).toBe("your steps first");
      tick(p, [1]);
      await p.untilStage("done");
      // Counted when the wait would have come: no stop at `steps`.
      expect(path(p)).not.toContain("steps");
      expect(steps(p).map((s) => s.done_at !== null)).toEqual([true, true]);
      // A step the plan doesn't have, and a mission without steps, are refused.
    } finally {
      p.cleanup();
    }
  }, 60_000);

  test("ship: no after steps goes straight to deploy", async () => {
    const p = world({ owner_steps: [], live_none_why: NONE_LIVE });
    await p.start();
    try {
      await p.untilStage("done");
      expect(path(p).slice(-3)).toEqual(["merge", "deploy", "done"]);
      expect(planFile(p)).not.toContain("## Your steps");
      expect(() => tick(p, "all")).toThrow(`${ID} has no steps`);
    } finally {
      p.cleanup();
    }
  }, 60_000);
});

describe("ship: the end without a live check", () => {
  let p: Pipe;

  beforeAll(async () => {
    p = world({ owner_steps: [], live_none_why: "" });
    await p.start();
    await p.untilStage("unverified");
    await p.loop.pass();
  }, 60_000);

  afterAll(() => p.cleanup());

  test("ship: no live block ends unverified", () => {
    const m = p.mission()!;
    expect([m.stage, m.waiting]).toEqual(["unverified", null]);
    expect(m.finished).not.toBeNull();
    expect(moves(p).at(-1)).toEqual({ from_stage: "deploy", event: "skip", to_stage: "unverified" });
    // No adapter call, no suite, no hold.
    expect(p.deployments).toEqual([]);
    expect(p.sandboxRuns.filter((r) => r.kind === "e2e")).toEqual([]);
  });

  test("ship: unverified marks the intent", () => {
    // The intent moves to done/ with `stage: done` as always, and says it was never checked live.
    const text = p.show("intents", "main", `done/${ID}-show-a-greeting/intent.md`);
    expect(text).toMatch(/stage: done\n/);
    expect(text).toMatch(/verified: no\n/);
    expect(text).not.toContain("waiting:");
    // Its repo's feature list doesn't say it is live.
    expect(p.show("intents", "main", "features/web.md")).not.toContain(ID);
  });
});

test("ship: nothing to check live ends done", async () => {
  const p = world({ owner_steps: [], live_none_why: NONE_LIVE });
  await p.start();
  try {
    await p.untilStage("done");
    await p.loop.pass();
    const text = p.show("intents", "main", `done/${ID}-show-a-greeting/intent.md`);
    expect(text).toMatch(/stage: done\n/);
    expect(text).not.toContain("verified:");
  } finally {
    p.cleanup();
  }
}, 60_000);

describe("ship: a live repo", () => {
  const URL = "https://web.example.dev";
  const LIVE = `---\nlive:\n  url: ${URL}\n  timeout: 5\n  suites:\n    - name: smoke\n      command: sh e2e/smoke.sh\n      tests: [e2e/smoke.sh]\n      smoke: true\n---\n`;

  test("ship: done only after steps, deploy and e2e", async () => {
    const p = new Pipe(
      { ...TARGET, "TOWERCAB.md": LIVE, "e2e/smoke.sh": "true\n" },
      intents(intent({ a: 5 })),
      { keep: true },
    );
    happy(p);
    p.respond.plan = reply({
      ...PLAN,
      owner_steps: [AFTER],
      e2e: { tests: [], none_why: "the change adds a file only" },
    });
    p.respond.worker = reply(build(), {
      "greeting.txt": "hello\n",
      "tests/greeting.sh": "test -f greeting.txt\n",
    });
    p.respond.review = reply(REVIEW);
    await p.start();
    try {
      await p.until(waitingOn(p, "your steps"));
      // Merged and waiting on the owner: nothing deployed, no suite run, not done.
      await p.until(() => false, 3);
      expect(p.mission()!.stage).toBe("steps");
      expect(p.sandboxRuns.filter((r) => r.kind === "e2e")).toEqual([]);
      tick(p, "all");
      await p.untilStage("deploy");
      p.platform = () => ({ state: "success" });
      p.deploy("owner/web", p.mission()!.merge_sha!, "deploy", null);
      const m = await p.untilStage("done");
      expect(path(p).slice(-5)).toEqual(["merge", "steps", "deploy", "e2e", "done"]);
      expect(p.sandboxRuns.filter((r) => r.kind === "e2e")).toHaveLength(1);
      expect(p.db.meta("lastgood:web")).toBe(m.merge_sha);
    } finally {
      p.cleanup();
    }
  }, 90_000);
});

test("ship: a fix round skips your steps", async () => {
  // A fix round (SHIP-11) ships a new PR; its merge goes to the deploy even if a step was unticked since.
  const { testDb } = await import("../helpers/world.ts");
  const { apply } = await import("../../src/machine.ts");
  const { getMission, insertMission } = await import("../../src/mission.ts");
  const db = testDb();
  const cx = { db, now: 100, subject: (m: Mission) => ({ title: m.intent, repo: m.repo, link: null }) };
  const mk = (data: Record<string, unknown>) => {
    const m = insertMission(db, { intent: ID, slug: "x", repo: "web", model: "m", a: 5 }, 1);
    db.run(
      "UPDATE missions SET stage = 'merge', step = '', data = ? WHERE id = ?",
      JSON.stringify(data),
      m.id,
    );
    return getMission(db, m.id)!;
  };
  const open = [{ n: 1, when: "after", text: "run the apply", why: "", done_at: null }];
  expect(
    apply(cx, mk({ steps: open, ship: { merges: ["a"], fixes: 1 } }), { event: "code_merged" }).stage,
  ).toBe("deploy");
  db.run("UPDATE missions SET stage = 'done' WHERE id = 1");
  expect(apply(cx, mk({ steps: open }), { event: "code_merged" }).stage).toBe("steps");
});
