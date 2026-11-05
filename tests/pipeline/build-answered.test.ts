// An answered change merges the base branch before it builds, and a head that moved goes through the
// checks again (LOOP-115).

import { expect, test } from "vitest";
import { insertCommand } from "../../src/commands.ts";
import { wait } from "../../src/machine.ts";
import { build, CODE, checkRun, happy, ID, intent, intents, reply, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const BRANCH = `towercab/${ID}-${SLUG}`;

test("loop: an answered change merges main before it builds and keeps the slot until CI is green", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5 })));
  happy(p);
  // The second round adds a file of its own, so it pushes a commit that carries the merge.
  p.queue("worker", reply(build(), CODE), reply(build(), { "round2.txt": "two\n" }));
  // The checks never finish, so the change waits at the checks after its first build round.
  p.newPrChecks = (pr) => (pr.head.endsWith("-spec") ? [] : [checkRun("test", "", 7, "IN_PROGRESS")]);
  await p.start();
  await p.until(() => p.mission()?.stage === "ci");
  const m = p.mission()!;
  expect(m.stage).toBe("ci");
  // It asks the owner something before its checks are green; main moves on meanwhile.
  p.loop.move(m, wait("answer the question"));
  expect(p.mission()!.stage).toBe("blocked");
  p.pushTo("web", "main", { "later.txt": "from main\n" }, "a later change");
  insertCommand(p.db, { name: "answer", arg: ID, text: "Carry on", source: "cli" }, p.clock.now());
  await p.until(
    () => JSON.parse(p.mission()!.data).answered === undefined && p.mission()!.stage !== "blocked",
  );
  await p.until(() => p.mission()?.stage === "ci" && p.mission()!.step !== "enter");
  // The branch on GitHub has main's new file, and the one-time mark is gone.
  expect(p.show("web", BRANCH, "later.txt")).toBe("from main\n");
  expect(JSON.parse(p.mission()!.data).answered).toBeUndefined();
}, 120_000);
