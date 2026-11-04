// The owner's steps outside the pipeline flows (SHIP-17, SHIP-22, LOOP-74, LOOP-75, UI-163): the plan
// text, the waits' messages, `after:`, the generated views, the status lines and the command line.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { main } from "../src/cli.ts";
import { Db } from "../src/db.ts";
import { doneView, todoView } from "../src/intents/views.ts";
import { apply, wait } from "../src/machine.ts";
import { dataOf, getMission, insertMission, type Mission } from "../src/mission.ts";
import { badAfter, decide, type PickState } from "../src/pick.ts";
import { renderStatus } from "../src/status.ts";
import {
  checklist,
  keepTicks,
  leftOf,
  numbered,
  type OwnerStep,
  parseNoneLive,
  parseSteps,
  renderSteps,
  withSteps,
} from "../src/steps.ts";
import { waitingFor } from "../src/ui/state.ts";
import { FakeTools, okResult } from "./helpers/tools.ts";
import { bareRepo, tempDir } from "./helpers/world.ts";
import { at, listing } from "./intents/fixtures.ts";

const STEPS: OwnerStep[] = numbered([
  { when: "before", text: "add the `NPM_TOKEN` secret", why: "the release needs it" },
  { when: "after", text: "run the apply (on the server)", why: "the server (not CI) needs the new settings" },
]);

function state(o: Partial<PickState> = {}): PickState {
  return {
    cutoff: 1,
    paused: false,
    blocked: null,
    repos: new Set(["web"]),
    full: new Map(),
    cooling: new Map(),
    active: new Set(),
    defaultModel: "opus",
    ...o,
  };
}

test("ship: plan steps are written and read back", () => {
  // The line format of SHIP-17, numbered by order, ticks with their time, parentheses kept apart.
  const md = renderSteps(STEPS);
  expect(md).toBe(
    "## Your steps\n\n- [ ] before merge: add the `NPM_TOKEN` secret (the release needs it)\n" +
      "- [ ] after merge: run the apply (on the server) (the server [not CI] needs the new settings)\n",
  );
  expect(renderSteps([])).toBe("");
  const ticked = STEPS.map((s) => (s.n === 1 ? { ...s, done_at: "2026-11-04T10:00:00+01:00" } : s));
  const file = withSteps("# Plan\n\n## Access\n\nNothing.\n", ticked, "Docs only.");
  expect(file).toContain(
    "- [x] before merge: add the `NPM_TOKEN` secret (the release needs it) · ticked 2026-11-04T10:00:00+01:00",
  );
  expect(parseNoneLive(file)).toBe("Docs only.");
  const back = parseSteps(file);
  expect(back.map((s) => [s.n, s.when, s.text, s.done_at])).toEqual([
    [1, "before", "add the `NPM_TOKEN` secret", "2026-11-04T10:00:00+01:00"],
    [2, "after", "run the apply (on the server)", null],
  ]);
  // Writing again replaces the section instead of adding one; a changed step loses its tick.
  expect(withSteps(file, ticked, "Docs only.")).toBe(file);
  const changed = keepTicks(numbered([{ when: "before", text: "add a different secret", why: "" }]), ticked);
  expect(changed[0]!.done_at).toBeNull();
  expect(keepTicks(numbered([{ when: "before", text: STEPS[0]!.text, why: "x" }]), ticked)[0]!.done_at).toBe(
    "2026-11-04T10:00:00+01:00",
  );
  expect(checklist(STEPS, "after")).toBe(
    "2. run the apply (on the server) (the server (not CI) needs the new settings)",
  );
  expect(leftOf(ticked, "your steps first")).toBe("0 of 1");
  expect(leftOf(ticked, "your steps")).toBe("1 of 1");
  expect(leftOf(ticked, "CI red")).toBeNull();
});

test("loop: waits for owner steps ask for the checklist", () => {
  const db = Db.memory();
  const now = 1_793_000_000;
  const cx = { db, now, subject: (m: Mission) => ({ title: "Show a greeting", repo: m.repo, link: null }) };
  const mk = (stage: string) => {
    const m = insertMission(
      db,
      { intent: `261026-${stage === "gate" ? "1000" : "1100"}`, slug: "x", repo: "web", model: "m", a: 5 },
      now,
    );
    db.run("UPDATE missions SET stage = ?, step = '' WHERE id = ?", stage, m.id);
    return getMission(db, m.id)!;
  };
  // Before the merge: a blocked wait from the gate, with the open steps as its why.
  const held = apply(cx, mk("gate"), wait("your steps first", checklist(STEPS, "before")));
  expect([held.stage, held.from_stage, held.waiting]).toEqual(["blocked", "gate", "your steps first"]);
  // After it: a wait at the `steps` stage, which stays a working stage.
  const open = apply(cx, mk("steps"), wait("your steps", checklist(STEPS, "after")));
  expect([open.stage, open.waiting]).toEqual(["steps", "your steps"]);
  const texts = db.all<{ mission: number; text: string }>(
    "SELECT mission, text FROM outbox ORDER BY mission",
  );
  expect(texts.find((t) => t.mission === held.id)!.text).toBe(
    "Do these before this change merges: tick them off in Towercab, or reply to change the plan.\n" +
      "Show a greeting (web)\n1. add the `NPM_TOKEN` secret (the release needs it)",
  );
  expect(texts.find((t) => t.mission === open.id)!.text).toBe(
    "Do these so the change works live: tick them off in Towercab.\nShow a greeting (web)\n" +
      "2. run the apply (on the server) (the server (not CI) needs the new settings)",
  );
});

test("loop: a reply at your steps does not move it", () => {
  const db = Db.memory();
  const now = 1_793_000_000;
  const cx = { db, now, subject: (m: Mission) => ({ title: "t", repo: m.repo, link: null }) };
  const m0 = insertMission(db, { intent: "261026-1000", slug: "x", repo: "web", model: "m", a: 5 }, now);
  db.run("UPDATE missions SET stage = 'steps', step = '' WHERE id = ?", m0.id);
  let m = apply(cx, getMission(db, m0.id)!, wait("your steps", "2. run the apply"));
  m = getMission(db, m.id)!;
  // A reply (`answered`), the owner's feedback and the merged PR being read again change nothing.
  for (const event of ["answered", "feedback", "code_merged", "head_moved", "conflict"] as const) {
    const after = apply(cx, m, { event, text: "please change the plan" });
    expect([after.stage, after.waiting, after.why], event).toEqual([
      "steps",
      "your steps",
      "2. run the apply",
    ]);
  }
  // Closing the PR still drops it, as for any wait.
  expect(apply(cx, m, { event: "closed" }).stage).toBe("stopped");
});

test("pick: after waits for steps and live checks", () => {
  const l = listing([
    at("intents/261001-0900-a", "stage: code\nwaiting: your steps\nsteps_left: 1 of 2\n", "web", "A"),
    at("intents/261001-0901-b", "after: 261001-0900\n", "web", "B"),
  ]);
  // A merged intent that still waits on the owner's steps (or the live check) is not done.
  expect(decide(l, state()).pick).toBeNull();
  expect(badAfter(l)).toEqual([]);
  const b = l.open.find((i) => i.id === "261001-0901")!;
  const missions = [{ intent: "261001-0900", stage: "steps", waiting: "your steps" }] as Mission[];
  expect(waitingFor({ listing: l, missions }, b)).toBe("Waiting for 261001-0900: your steps.");
  expect(
    waitingFor({ listing: l, missions: [{ ...missions[0]!, stage: "e2e", waiting: null }] as Mission[] }, b),
  ).toBe("Waiting for 261001-0900: running e2e.");
  // A rolled back or dropped one doesn't count as done either.
  const dropped = listing([
    at("done/261001-0900-a", "stage: dropped\n", "web", "A"),
    at("intents/261001-0901-b", "after: 261001-0900\n", "web", "B"),
  ]);
  expect(decide(dropped, state()).pick).toBeNull();
  expect(badAfter(dropped)).toEqual([{ id: "261001-0901", ids: ["261001-0900"] }]);
});

test("pick: after accepts an unverified end", () => {
  // An intent that ended unverified is written `stage: done` and moved to done/, so it counts.
  const l = listing([
    at("done/261001-0900-a", "stage: done\nverified: no\n", "web", "A"),
    at("intents/261001-0901-b", "after: 261001-0900\n", "web", "B"),
  ]);
  expect(l.done[0]!.verified).toBe("no");
  expect(decide(l, state()).pick?.id).toBe("261001-0901");
  const done = listing([
    at("done/261001-0900-a", "stage: done\n", "web", "A"),
    at("intents/261001-0901-b", "after: 261001-0900\n", "web", "B"),
  ]);
  expect(decide(done, state()).pick?.id).toBe("261001-0901");
});

test("intents: TODO shows steps left", () => {
  const l = listing([
    at("intents/261001-0900-a", "stage: code\nwaiting: your steps\nsteps_left: 2 of 3\n", "web", "A"),
    at("intents/261001-0901-b", "stage: code\nwaiting: your steps first\nsteps_left: 1 of 1\n", "web", "B"),
    at("intents/261001-0902-c", "stage: code\nwaiting: answer the question\n", "web", "C"),
  ]);
  const todo = todoView(l, 1);
  expect(todo).toContain("## Waiting on me\n");
  expect(todo).toContain(
    "- [261001-0900](intents/261001-0900-a/intent.md) web: A · **your steps** · 2 of 3 left",
  );
  expect(todo).toContain("web: B · **your steps first** · 1 of 1 left");
  // A wait that isn't about steps has no count.
  expect(todo).toMatch(/web: C · \*\*answer the question\*\*\n/);
});

test("intents: DONE marks unverified", () => {
  const l = listing([
    at("done/261001-0900-a", "stage: done\nverified: no\nfinished: 2026-11-04T10:00:00+01:00\n", "web", "A"),
    at("done/261001-0901-b", "stage: done\nfinished: 2026-11-04T11:00:00+01:00\n", "web", "B"),
  ]);
  const done = doneView(l, "");
  expect(done).toMatch(/web: A \(merged, not verified live\) · no PR/);
  expect(done).toMatch(/web: B · no PR/);
  expect(done.match(/not verified live/g)).toHaveLength(1);
});

test("cli: status shows steps", () => {
  const db = Db.memory();
  const now = 1_793_000_000;
  const m = insertMission(db, { intent: "261026-1000", slug: "a", repo: "web", model: "opus", a: 5 }, now);
  db.run(
    "UPDATE missions SET stage = 'steps', step = '', waiting = 'your steps', data = ? WHERE id = ?",
    JSON.stringify({
      steps: [
        { ...STEPS[0]!, when: "after" },
        { ...STEPS[1]!, done_at: "2026-11-04T10:00:00+01:00" },
      ],
    }),
    m.id,
  );
  const text = renderStatus({
    db,
    listing: listing([at("intents/261026-1000-a", "", "web", "Show a greeting")]),
    listingError: null,
    running: 42,
    version: "1.0.0",
    now,
    problems: [],
    next: "next: nothing open",
    prLink: () => null,
    queued: new Set(),
  });
  // The stage that waits on the owner is listed under "waiting on you", not as work in progress.
  expect(text).toContain("working: nothing");
  expect(text).toContain(
    "waiting on you:\n- 261026-1000 web: Show a greeting · Do these so the change works live: tick them off in Towercab. (1 of 2 left)",
  );
});

// ── the command line ────────────────────────────────────────────────────────────────────────────

let out = "";
let err = "";
beforeEach(() => {
  out = "";
  err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out += String(s);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    err += String(s);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

test("ship: ticking steps from the CLI", async () => {
  const intents = bareRepo({ "intents/.keep": "" });
  const dir = tempDir();
  const config = join(dir, "config.toml");
  writeFileSync(
    config,
    `[intents]\nremote = "${intents}"\n\n[github]\napp_id = 1\nme = "owner"\n\n[repos.web]\ngithub = "owner/web"\n`,
  );
  const g = ["--config", config, "--home", join(dir, "home")];
  const t = new FakeTools().on("systemctl", () => okResult());
  expect(await main([...g, "add", "web: Show a greeting"], t)).toBe(0);
  const id = /^(\d{6}-\d{4}) /m.exec(out)!;
  // No steps yet: a refusal that says so.
  expect(await main([...g, "step", id[1]!, "1"], t)).toBe(1);
  expect(err).toContain(`${id[1]} has no steps`);

  // Give the intent's mission steps (the pipeline reads them from the plan), then tick from the CLI.
  const db = new Db(join(dir, "home", "towercab.db"));
  const m = insertMission(
    db,
    { intent: id[1]!, slug: "show-a-greeting", repo: "web", model: "opus", a: 5 },
    1,
  );
  db.run(
    "UPDATE missions SET stage = 'steps', step = '', data = ? WHERE id = ?",
    JSON.stringify({ steps: STEPS }),
    m.id,
  );
  out = "";
  err = "";
  expect(await main([...g, "step", id[1]!, "1"], t)).toBe(0);
  expect(out).toContain("ticked 1; steps left: 2. run the apply");
  const ticked = dataOf<{ steps: OwnerStep[]; stepsDirty?: number }>(getMission(db, m.id)!);
  expect(ticked.steps.map((s) => s.done_at !== null)).toEqual([true, false]);
  expect(ticked.stepsDirty).toBe(1);
  // `all` ticks the rest; a number that isn't a step is refused, and so is nonsense.
  out = "";
  expect(await main([...g, "step", id[1]!, "all"], t)).toBe(0);
  expect(out).toContain("no steps left");
  err = "";
  expect(await main([...g, "step", id[1]!, "7"], t)).toBe(1);
  expect(err).toContain(`step 7 isn't one of ${id[1]}'s steps`);
  expect(await main([...g, "step", id[1]!, "x"], t)).toBe(2);
  expect(await main([...g, "step", id[1]!], t)).toBe(2);
  db.close();
});
