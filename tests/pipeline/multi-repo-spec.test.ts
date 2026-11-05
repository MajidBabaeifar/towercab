// INT-44: a multi-repo intent has one spec PR and one plan PR, both in the lead, and one stage.

import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { happy, ID, intent, intents, ownerMerges, PLAN, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;

const PARTS = {
  ...PLAN,
  repos: [
    { repo: "infra", change: "Accept the new setting.", waits_on: [], safe_alone: "Nothing reads it yet." },
    {
      repo: "web",
      change: "Send the setting.",
      waits_on: ["infra"],
      safe_alone: "Infra already accepts it.",
    },
  ],
};

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 2, extra: "repos: [infra]\n" })), { keep: true });
  // A second repo the intent changes, with its own remote.
  p.bares.infra = p.bareRepo(TARGET);
  appendFileSync(p.gitconfig, `[url "${p.bares.infra}"]\n\tinsteadOf = https://github.com/owner/infra.git\n`);
  happy(p);
  p.respond.plan = reply(PARTS);
  await p.start({ repos: { web: { github: "owner/web" }, infra: { github: "owner/infra" } } });
}, 30_000);

afterAll(() => p.cleanup());

test("pipeline: a multi-repo intent has one spec PR and one plan PR in the lead", async () => {
  const spec = await p.untilStage("approval:spec");
  expect(p.prs.filter((x) => x.repo === "owner/web")).toHaveLength(1);
  expect(p.prs.filter((x) => x.repo === "owner/infra")).toHaveLength(0);
  ownerMerges(p);
  const plan = await p.untilStage("approval:plan");
  // The spec PR is the lead's; the plan PR is in the intents repo; the other repo has none.
  expect(p.prNo("web", spec.spec_pr!).state).toBe("MERGED");
  expect(p.prs.filter((x) => x.repo === "owner/intents")).toHaveLength(1);
  expect(p.prs.filter((x) => x.repo === "owner/infra")).toHaveLength(0);
  // The plan names a part per repo, in landing order, in the one plan.
  const data = JSON.parse(plan.data) as { plan: { parts: string[]; md: string } };
  expect(data.plan.parts).toEqual(["infra", "web"]);
  expect(data.plan.md).toContain("## Repos");
  expect(data.plan.md.indexOf("### infra")).toBeLessThan(data.plan.md.indexOf("### web"));
});

test("intents: the stage is one for all parts", async () => {
  // One mission, one `stage` on the intent file: a phase of the whole intent, no field per repo.
  const m = p.mission()!;
  expect(p.db.all("SELECT id FROM missions WHERE intent = ?", ID)).toHaveLength(1);
  const i = await p.store.get(ID);
  expect(i.stage).toBe("plan");
  expect(i.repo).toBe("web");
  expect(i.repos).toEqual(["infra"]);
  expect(i.text).not.toMatch(/^(stage_|parts)/m);
  expect(m.repo).toBe("web");
});
