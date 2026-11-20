// PIP-231: a lighter kind that outgrows its path becomes a question, never a silent change.

import { expect, test } from "vitest";
import { next } from "../../src/machine.ts";
import { build, DESIGN, happy, intent, intents, PLAN, PLAN_MD, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const SPEC_FILE = "specs/area.md";
const SPEC_V1 = `# Area

**Status:** Draft

### ABC-1 · First

The first row.

- Verified by: \`area: first\`

### ABC-2 · Second

The second row.

- Verified by: \`area: second\`
`;

function world(kind: string, specAfter: string | null): Pipe {
  const p = new Pipe(
    { ...TARGET, [SPEC_FILE]: SPEC_V1 },
    intents(intent({ a: 5, extra: `kind: ${kind}\n` })),
    {
      keep: true,
    },
  );
  happy(p);
  p.respond.plan = reply({ ...PLAN, plan: `${PLAN_MD}\n\nFixes: ABC-1\n` });
  const edits: Record<string, string> = {
    "greeting.txt": "hello\n",
    "tests/new.sh": "test -f greeting.txt\n",
  };
  if (specAfter) edits[SPEC_FILE] = specAfter;
  p.respond.worker = () => ({ structured: build(), edits });
  return p;
}

const asked = (p: Pipe) => p.until(() => p.mission()?.waiting === "answer the question");

test("pipeline: a bugfix that adds a requirement asks to move to the full path", async () => {
  const p = world(
    "bugfix",
    `${SPEC_V1}\n### ABC-3 · Third\n\nA new row.\n\n- Verified by: \`area: third\`\n`,
  );
  try {
    await p.start();
    await asked(p);
    expect(p.mission()!.why).toBe("Move this to the full path?");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a bugfix that changes another row asks to move to the full path", async () => {
  const p = world("bugfix", SPEC_V1.replace("The second row.", "The second row, changed."));
  try {
    await p.start();
    await asked(p);
    expect(p.mission()!.why).toBe("Move this to the full path?");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: a bugfix that edits only its own row stays a bugfix", async () => {
  const p = world("bugfix", SPEC_V1.replace("The first row.", "The first row, fixed."));
  try {
    await p.start();
    await p.untilStage("done");
    expect(p.moves()).not.toContain("kind_routed (the owner");
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: choosing feature starts design and keeps the branch", async () => {
  const p = world("refactor", SPEC_V1.replace("The first row.", "The first row, changed."));
  try {
    await p.start();
    await asked(p);
    const m = p.mission()!;
    p.ownerComment(p.prNo("intents", m.plan_pr!), "feature");
    p.clock.advance(61);
    await p.until(() => p.moves().includes("→ design (kind_routed"));
    expect(p.mission()!.branch).toBe(m.branch);
  } finally {
    p.cleanup();
  }
}, 120_000);

test("pipeline: towercab never lightens a kind by itself", () => {
  // A kind routed past the plan changes nothing for a lighter kind: only the owner lightens, before a stage starts.
  for (const at of ["build", "verify", "publish", "review"] as const)
    expect(next(at, "kind_routed", null, { steps: false, nothingLive: false, kind: "bugfix" })).toEqual({
      kind: "ignore",
    });
});

test("pipeline: a spec-only design that needs code asks first", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 5, extra: "kind: spec-only\n" })), { keep: true });
  happy(p);
  p.respond.design = reply({
    ...DESIGN,
    concerns: [{ what: "kind_changed", why: "The change needs code." }],
  });
  try {
    await p.start();
    await asked(p);
    expect(p.mission()!.why).toBe("Move this to the full path?");
    expect(p.mission()!.stage).toBe("blocked");
  } finally {
    p.cleanup();
  }
}, 120_000);
