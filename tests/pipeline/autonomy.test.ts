// Unplanned access at a4 (AUT-15): access asked for mid-build is granted at once, but the code PR then
// goes to the owner instead of merging.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { build, CODE, happy, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

/** The owner merges whatever PR a mission waits on. */
function ownerMerges(p: Pipe): void {
  for (const m of p.db.all<Mission>("SELECT * FROM missions WHERE stage LIKE 'approval:%' AND step = ''")) {
    const [repo, n] =
      m.stage === "approval:spec"
        ? ["web", m.spec_pr]
        : m.stage === "approval:plan"
          ? ["intents", m.plan_pr]
          : ["web", m.pr];
    const pr = p.prNo(repo!, n!);
    if (pr.state === "OPEN") p.mergePr(pr);
  }
}

test("autonomy: unplanned access at a4 goes to the owner", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 4 })));
  happy(p);
  p.queue(
    "worker",
    reply(
      build({
        status: "access",
        pr: null,
        access: { domains: [], paths: [{ glob: ".github/workflows/ci.yml", why: "the new job" }] },
      }),
    ),
    reply(build(), { ...CODE, ".github/workflows/ci.yml": "name: CI\n" }),
  );
  await p.start();
  await p.until(() => {
    ownerMerges(p);
    return p.mission()?.stage === "approval:merge" || p.mission()?.stage === "done";
  });
  const m = p.mission()!;
  expect([m.stage, m.waiting, m.why], p.moves()).toEqual([
    "approval:merge",
    "review and merge PR",
    "access beyond the plan",
  ]);
  // Granted at once: the worker resumed with it, and the guard now lets it write the path.
  const [ask, resumed] = p.claudeCalls.filter((c) => c.kind === "worker");
  expect(resumed!.prompt).toBe("Access granted: .github/workflows/ci.yml. Continue the build.");
  expect(resumed!.session).toEqual({ mode: "resume", id: ask!.session.id });
  const guard = JSON.parse(readFileSync(join(p.home.runs(m.intent, "build"), "guard.json"), "utf8")) as {
    granted: string[];
  };
  expect(guard.granted).toEqual([".github/workflows/ci.yml"]);
  expect(p.stages(m.id)).not.toContain("blocked");
  // The review approved and CI passed; only the access sends it to the owner, and the PR says why.
  expect(JSON.parse(m.data).review.approved).toBe(true);
  const body = p.prNo("web", m.pr!).body;
  expect(body).toContain("## Access beyond the plan\n\n- writing .github/workflows/ci.yml: the new job");
  expect(p.show("web", `towercab/${m.intent}-show-a-greeting`, ".github/workflows/ci.yml")).toBe(
    "name: CI\n",
  );
}, 30_000);
