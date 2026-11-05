// INT-44: until one PR per repo is built (LOOP-78), an intent with `repos:` is held before it builds.

import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { happy, intent, intents, ownerMerges, PLAN, reply, TARGET } from "../helpers/flows.ts";
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
  p = new Pipe(TARGET, intents(intent({ a: 2, extra: "repos: [infra]\n" })), { keep: true });
  p.bares.infra = p.bareRepo(TARGET);
  appendFileSync(p.gitconfig, `[url "${p.bares.infra}"]\n\tinsteadOf = https://github.com/owner/infra.git\n`);
  happy(p);
  p.respond.plan = reply(PARTS);
  await p.start({ repos: { web: { github: "owner/web" }, infra: { github: "owner/infra" } } });
}, 30_000);

afterAll(() => p.cleanup());

test("pipeline: a multi-repo intent is held before it builds", async () => {
  await p.untilStage("approval:spec");
  ownerMerges(p);
  await p.untilStage("approval:plan");
  ownerMerges(p);
  const held = await p.untilStage("blocked");
  expect(held.waiting).toBe("several repos");
  // Nothing was built, and no code PR was opened in any repo.
  expect(p.claudeCalls.filter((c) => c.kind === "worker")).toHaveLength(0);
  expect(p.mission()!.pr).toBeNull();
  expect(p.prs.filter((x) => x.repo === "owner/infra")).toHaveLength(0);
  expect(p.prs.filter((x) => x.repo === "owner/web")).toHaveLength(1);
});
