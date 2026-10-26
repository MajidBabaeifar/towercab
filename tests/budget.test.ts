// The daily budget (MET-29): reached → nothing new starts until midnight.

import { afterEach, expect, test } from "vitest";
import { Pipe } from "./helpers/pipe.ts";

let saved: string | undefined;
afterEach(() => {
  if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved;
});

const INTENT = "---\nrepo: web\nu: 4\ni: 4\nsource: me\n---\n\n# Intent: Next thing\n";

test("metrics: daily budget pauses picks", async () => {
  saved = process.env.GIT_CONFIG_GLOBAL;
  const p = new Pipe({ "CLAUDE.md": "x\n" }, { "intents/261026-1000-next-thing/intent.md": INTENT });
  // An earlier mission spent $45 today.
  const now = p.clock.now();
  p.db.run(
    `INSERT INTO missions (intent, repo, attempt, stage, step, model, session, checkout, branch, data, created, updated)
     VALUES ('261026-0900', 'web', 1, 'done', '', 'opus', 's', 'work/x', 'towercab/x', ?, ?, ?)`,
    JSON.stringify({ runs: [{ at: now - 60, cost: 45 }] }),
    now,
    now,
  );
  await p.start({ agent: { ci_grace: 0, ci_poll: 5, toolchain: [], daily_budget_usd: 40 } });
  const r = await p.loop.pass();
  expect(r.picked).toBeNull();
  expect(p.db.all("SELECT intent FROM missions WHERE intent = '261026-1000'")).toEqual([]);
  // Without the budget the same pass picks it.
  const q = new Pipe({ "CLAUDE.md": "x\n" }, { "intents/261026-1000-next-thing/intent.md": INTENT });
  await q.start();
  expect((await q.loop.pass()).picked).toBe("261026-1000");
});
