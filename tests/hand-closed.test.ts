// LOOP-140, LOOP-141: an intent the owner closed by hand has no open file left to write, and the mission's
// move to its end state still settles in one pass.

import { expect, test } from "vitest";
import { insertCommand } from "../src/commands.ts";
import { type IntentStore, NoOpenIntentError, SyncError } from "../src/intents/types.ts";
import { build, CODE, checkRun, happy, ID, intent, intents, SLUG, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";

const BRANCH = `towercab/${ID}-${SLUG}`;
const retry = (p: Pipe) => p.logs.filter((l) => /entering \S+ failed, retrying next pass/.test(l));

/** A store whose `update` first runs `before(what)`, as the owner's own write landing just ahead of the loop's. */
function hooked(before: (s: IntentStore, what: string) => Promise<void>) {
  return (s: IntentStore): IntentStore =>
    new Proxy(s, {
      get(target, prop) {
        if (prop === "update") {
          return async (...a: Parameters<IntentStore["update"]>) => {
            await before(target, a[1]);
            return target.update(...a);
          };
        }
        const v = Reflect.get(target, prop) as unknown;
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
}

/** The owner's `towercab done`/`drop`: the file moves to `done/` before the loop's entry write. */
const closeBy = (what: string, gone = false) => {
  let once = false;
  return hooked(async (s, w) => {
    if (w !== what || once) return;
    once = true;
    if (gone) throw new NoOpenIntentError(`no open intent matches ${ID}`);
    await s.update(ID, "by hand", (e) => e.setField("stage", w === "done" ? "done" : "dropped"));
  });
};

/** A mission that waits at "no changes", where "I did it myself" applies. */
async function atNoChanges(wrapStore?: (s: IntentStore) => IntentStore) {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  let round = 0;
  p.respond.worker = () => {
    round++;
    if (round === 1) return { structured: build(), edits: CODE };
    return { structured: build({ notes: "Nothing to fix: the checks pass here." }) };
  };
  await p.start({}, wrapStore ? { wrapStore } : {});
  await p.until(() => {
    const pr = p.prs.find((x) => x.head === BRANCH);
    if (pr) pr.checks = () => [checkRun("test", "FAILURE", 300)];
    return p.mission()?.stage === "blocked";
  });
  expect(p.mission()!.waiting).toBe("no changes");
  return p;
}

test("loop: done on a blocked mission whose intent file was already moved settles in one pass", async () => {
  const p = await atNoChanges(closeBy("done"));
  insertCommand(p.db, { name: "done", arg: ID, text: "", source: "cli" }, p.clock.now());
  await p.loop.pass();
  expect(p.mission()!.stage, p.moves()).toBe("done");
  expect(p.mission()!.step, p.logs.slice(-5).join("\n")).not.toBe("enter");
  expect(retry(p)).toEqual([]);
  p.cleanup();
}, 60_000);

/** An a2 intent held at the spec PR. */
async function atSpec(wrapStore: (s: IntentStore) => IntentStore) {
  const p = new Pipe(TARGET, intents(intent({ a: 2 })));
  happy(p);
  await p.start({}, { wrapStore });
  const m = await p.untilStage("approval:spec");
  return { p, pr: p.prNo("web", m.spec_pr!), spec: `${BRANCH}-spec` };
}

test("loop: drop on a blocked mission whose intent file was already moved settles in one pass", async () => {
  for (const gone of [false, true]) {
    const { p, pr, spec } = await atSpec(closeBy("stopped", gone));
    insertCommand(p.db, { name: "drop", arg: ID, text: "", source: "cli" }, p.clock.now());
    await p.loop.pass();
    expect(p.mission()!.stage, p.moves()).toBe("stopped");
    expect(p.mission()!.step).not.toBe("enter");
    expect(retry(p)).toEqual([]);
    // The rest of the entry still ran (PIP-87).
    expect(pr.state).toBe("CLOSED");
    expect(p.deleted).toEqual([`owner/web ${spec}`]);
    p.cleanup();
  }
}, 120_000);

test("loop: a sync failure still retries the entry of a finished mission", async () => {
  let fail = true;
  const p = await atNoChanges(
    hooked(async (_s, what) => {
      if (what === "done" && fail) throw new SyncError("push rejected");
    }),
  );
  insertCommand(p.db, { name: "done", arg: ID, text: "", source: "cli" }, p.clock.now());
  await p.loop.pass();
  expect(p.mission()!.stage).toBe("done");
  expect(p.mission()!.step).toBe("enter");
  expect(retry(p)).toHaveLength(1);
  fail = false;
  await p.until(() => p.mission()?.stage === "done" && p.mission()?.step !== "enter");
  p.cleanup();
}, 60_000);

test("loop: entering an active stage with the intent file missing is still retried", async () => {
  let armed = false;
  const p = await atNoChanges(
    hooked(async (_s, what) => {
      if (armed && what === "build") throw new NoOpenIntentError(`no open intent matches ${ID}`);
    }),
  );
  armed = true;
  insertCommand(p.db, { name: "answer", arg: ID, text: "go on", source: "cli" }, p.clock.now());
  await p.loop.pass();
  expect(p.mission()!.stage).toBe("build");
  expect(p.mission()!.step).toBe("enter");
  expect(retry(p)[0]).toContain("no open intent matches");
  p.cleanup();
}, 60_000);
