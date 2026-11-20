// LOOP-80: a part that needed the owner's approval is counted at the gate; the approval is asked once for
// the intent, and the landing starts when it is given.

import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { freezes } from "../src/freeze.ts";
import { partsOf } from "../src/parts.ts";
import { createActions } from "../src/ui/actions.ts";
import { happy, intent, intents, PLAN, reply, TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";

let p: Pipe;

const PARTS = {
  ...PLAN,
  repos: [
    { repo: "infra", change: "Accept the new setting.", waits_on: [], safe_alone: "Nothing reads it yet." },
    { repo: "web", change: "Send the setting.", waits_on: ["infra"], safe_alone: "Infra accepts it." },
  ],
};

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 2, extra: "repos: [infra]\n" })), { keep: true });
  p.bares.infra = p.bareRepo(TARGET);
  appendFileSync(p.gitconfig, `[url "${p.bares.infra}"]\n\tinsteadOf = https://github.com/owner/infra.git\n`);
  happy(p);
  p.respond.plan = reply(PARTS);
  await p.start({ repos: { web: { github: "owner/web" }, infra: { github: "owner/infra" } } });
}, 30_000);

afterAll(() => p.cleanup());

test("loop: the owner approves a multi-repo landing once", async () => {
  await p.untilStage("approval:spec", 30);
  p.mergePr(p.prs.find((x) => x.repo === "owner/web")!);
  const plan = await p.untilStage("approval:plan", 30);
  p.mergePr(p.prNo("intents", plan.plan_pr!));
  const m = await p.untilStage("approval:merge", 400);
  expect(partsOf(m).every((x) => x.atGate)).toBe(true);
  expect(partsOf(m).some((x) => x.data?.needsApproval === true)).toBe(true);
  // Nothing is frozen or merged before the owner says so.
  expect(freezes(p.db)).toEqual([]);
  // The owner's yes starts the landing: the repos freeze and the parts merge in order.
  const actions = createActions({
    db: p.db,
    store: p.store,
    config: undefined as never,
    clock: p.clock,
    github: { owner: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
  });
  await actions.merge(m.intent);
  await p.untilStage("done", 60);
  expect(partsOf(p.mission()!).map((x) => x.merged)).toEqual([true, true]);
  expect(freezes(p.db)).toEqual([]);
});
