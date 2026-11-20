// INT-44: until one PR per repo is built (LOOP-78), an intent with `repos:` is held before it builds.

import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { insertCommand } from "../../src/commands.ts";
import { partsOf } from "../../src/parts.ts";
import { happy, intent, intents, PLAN, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;

const PARTS = {
  ...PLAN,
  repos: [
    { repo: "infra", change: "Accept the new setting.", waits_on: [], safe_alone: "Nothing reads it yet." },
    { repo: "web", change: "Send the setting.", waits_on: ["infra"], safe_alone: "Infra accepts it." },
  ],
};

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 5, extra: "repos: [infra]\n" })), { keep: true });
  p.bares.infra = p.bareRepo(TARGET);
  appendFileSync(p.gitconfig, `[url "${p.bares.infra}"]\n\tinsteadOf = https://github.com/owner/infra.git\n`);
  happy(p);
  p.respond.plan = reply(PARTS);
  await p.start({ repos: { web: { github: "owner/web" }, infra: { github: "owner/infra" } } });
}, 30_000);

afterAll(() => p.cleanup());

test("loop: parts build in parallel, one PR per repo", async () => {
  // Every part builds and passes its checks; the mission leaves the parts once all are at the gate.
  await p.until(() => {
    const m = p.mission();
    return !!m && partsOf(m).length === 2 && partsOf(m).every((x) => x.atGate);
  }, 400);
  const m = p.mission()!;
  // Landing them in order is the merge step; until then the mission holds at merge.
  expect(["merge", "blocked"]).toContain(m.stage);
  expect(partsOf(m).map((x) => x.repo)).toEqual(["infra", "web"]);
  // One worker run and one PR per repo: nothing waited for the other.
  expect(p.claudeCalls.filter((c) => c.kind === "worker")).toHaveLength(2);
  expect(p.prs.filter((x) => x.repo === "owner/infra" && x.state === "OPEN")).toHaveLength(1);
  expect(p.prs.filter((x) => x.repo === "owner/web" && x.state === "OPEN")).toHaveLength(1);
  expect(new Set(partsOf(m).map((x) => x.pr)).size).toBe(2);
});

test("loop: dropping a multi-repo intent closes every part's PR", async () => {
  const m = p.mission()!;
  const numbers = partsOf(m).map((x) => x.pr);
  const open = p.prs.filter((x) => numbers.includes(x.number));
  expect(open.map((x) => x.state)).toEqual(["OPEN", "OPEN"]);
  insertCommand(p.db, { name: "drop", arg: m.intent, text: "", source: "cli" }, p.clock.now());
  await p.untilStage("stopped");
  expect(open.map((x) => x.state)).toEqual(["CLOSED", "CLOSED"]);
});
