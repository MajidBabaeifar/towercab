// Unplanned access at a4 (AUT-15, AUT-27): access asked for mid-build is a question to the owner, never
// granted by Towercab itself; once the owner allows it, the code PR goes to them instead of merging.

import { expect, test } from "vitest";
import { gate } from "../../src/autonomy.ts";
import { build, happy, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

test("autonomy: unplanned access at a4 goes to the owner", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 4 })));
  try {
    happy(p);
    p.queue(
      "worker",
      reply(
        build({
          status: "access",
          pr: null,
          access: {
            domains: [],
            paths: [{ glob: ".github/workflows/ci.yml", why: "the new job" }],
            tests: [],
          },
        }),
      ),
    );
    await p.start();
    const m = await p.untilStage("blocked");
    // Not granted by Towercab: the mission waits with a question that names the path and why, and the
    // worker has not been resumed.
    expect([m.waiting, m.why]).toEqual([
      "answer the question",
      "May the worker have .github/workflows/ci.yml?",
    ]);
    const d = JSON.parse(m.data) as Record<string, unknown>;
    expect(d.unplanned).toBeUndefined();
    expect(d.accessAsk).toEqual({
      domains: [],
      paths: [{ glob: ".github/workflows/ci.yml", why: "the new job" }],
    });
    expect(p.claudeCalls.filter((c) => c.kind === "worker")).toHaveLength(1);
  } finally {
    p.cleanup();
  }
  // Once the owner has allowed it, the gate still sends the a4 PR to the owner, with the reason.
  const held = gate({
    a: 4,
    ciGreen: true,
    review: { approved: true },
    unplanned: true,
    proven: true,
    risk: "low",
  });
  expect(held).toEqual({ merge: false, why: "The agent needed access the approved plan didn't grant." });
}, 30_000);
