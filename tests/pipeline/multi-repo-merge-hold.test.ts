// INT-44: the merge step never merges only the lead of a multi-repo intent, even one that gained
// `repos:` after its build began.

import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mergeHandler } from "../../src/pipeline/gate.ts";
import { happy, intent, intents, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 2, extra: "repos: [infra]\n" })), { keep: true });
  p.bares.infra = p.bareRepo(TARGET);
  appendFileSync(p.gitconfig, `[url "${p.bares.infra}"]\n\tinsteadOf = https://github.com/owner/infra.git\n`);
  happy(p);
  await p.start({ repos: { web: { github: "owner/web" }, infra: { github: "owner/infra" } } });
}, 30_000);

afterAll(() => p.cleanup());

test("pipeline: merge holds a multi-repo intent", async () => {
  const m = await p.untilStage("approval:spec");
  const r = await mergeHandler.step(p.loop.ctx(), m);
  expect(r).toMatchObject({ done: { event: "wait", waiting: "several repos" } });
  // It asked GitHub for nothing and merged nothing.
  expect(p.prs.filter((x) => x.state === "MERGED")).toHaveLength(0);
});
