// Every level runs every check (AUT-6): five intents, a1 to a5, through the real pipeline at once;
// the owner merges whatever waits on them. Autonomy only moves who merges.

import { expect, test } from "vitest";
import type { Mission } from "../../src/mission.ts";
import { build, DESIGN, happy, intent, TARGET } from "../helpers/flows.ts";
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

test("autonomy: every stage runs at every level", async () => {
  const files: Record<string, string> = {};
  for (let a = 1; a <= 5; a++)
    files[`intents/261026-100${a}-level-${a}/intent.md`] = intent({ a, title: `Level ${a}`, u: 5, i: 5 });
  const p = new Pipe(TARGET, files);
  happy(p);
  // Each intent writes its own files, so their PRs never conflict.
  const level = (cwd: string) => /261026-100(\d)-1/.exec(cwd)![1]!;
  p.respond.design = (spec) => {
    const n = level(spec.cwd);
    return {
      structured: { ...DESIGN, spec_ids: [`WEB-${n}`] },
      edits: { [`specs/web-${n}.md`]: `# Web ${n}\n\n### WEB-${n} · Level ${n}\n` },
    };
  };
  p.respond.worker = (spec) => {
    const n = level(spec.cwd);
    return {
      structured: build(),
      edits: { [`greeting-${n}.txt`]: "hello\n", [`tests/greeting-${n}.sh`]: `test -f greeting-${n}.txt\n` },
    };
  };
  await p.start({ repos: { web: { github: "owner/web", workers: 5 } }, agent: { parallel: 5 } });
  const done = await p.until(() => {
    ownerMerges(p);
    const ms = p.db.all<Mission>("SELECT * FROM missions");
    return ms.length === 5 && ms.every((m) => m.stage === "done");
  }, 80);
  expect(done, p.moves()).toBeGreaterThan(0);
  const checks = ["verify", "proof", "publish", "ci", "review", "gate"];
  const waits: Record<number, string[]> = {};
  for (const m of p.db.all<Mission>("SELECT * FROM missions ORDER BY intent")) {
    const a = Number(m.intent.slice(-1));
    const st = p.stages(m.id);
    for (const s of checks) expect(st, `a${a}`).toContain(s);
    waits[a] = st.filter((s) => s.startsWith("approval:"));
    // Merged only after CI and an approving review.
    expect(JSON.parse(m.data).review.approved).toBe(true);
  }
  // Autonomy only moves who merges; at low risk a4 and a5 need nobody (AUT-18).
  expect(waits).toEqual({
    1: ["approval:spec", "approval:plan", "approval:merge"],
    2: ["approval:spec", "approval:plan", "approval:merge"],
    3: ["approval:plan", "approval:merge"],
    4: [],
    5: [],
  });
}, 60_000);
