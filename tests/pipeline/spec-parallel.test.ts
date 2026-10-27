// Several designs at once (PIP-80, PIP-81): each is told the IDs other open spec PRs add, and a spec
// PR that conflicts with main is revised.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DESIGN, happy, intent, intents, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const OTHER = {
  "specs/other.md": "# Other\n\n### OTH-7 · Elsewhere\n\nSomething else.\n\n### OTH-8 · More\n\nMore.\n",
};

describe("spec IDs", () => {
  let p: Pipe;
  const calls = () => p.claudeCalls.filter((c) => c.kind === "design");

  beforeAll(async () => {
    p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
    happy(p);
    p.openOtherPr("web", "towercab/261026-0900-other-spec", OTHER);
    // A PR whose branch isn't on the remote can't be read.
    p.openOtherPr("web", "towercab/261026-0901-ghost-spec", {}, false);
    await p.start();
    await p.untilStage("approval:spec");
  }, 30_000);

  afterAll(() => p.cleanup());

  test("pipeline: design is told the IDs other spec PRs add", () => {
    const prompt = calls()[0]!.prompt;
    expect(prompt).toContain("IDs already taken by other open spec PRs (do not use them): OTH-7, OTH-8.");
    expect(prompt).toContain("Take the next free requirement IDs.");
  });

  test("pipeline: an unreadable spec PR does not stop the design", () => {
    expect(p.mission()!.stage).toBe("approval:spec");
    expect(p.logs.some((l) => /spec PR #\d+: can't read its IDs, skipped/.test(l))).toBe(true);
  });
});

let q: Pipe;

test("pipeline: a conflicting spec PR is revised", async () => {
  q = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(q);
    await q.start();
    const m = await q.untilStage("approval:spec");
    const pr = q.prNo("web", m.spec_pr!);
    // Another spec change reaches main first and touches the same file.
    q.pushTo(
      "web",
      "main",
      { "specs/web.md": "# Web\n\n### WEB-9 · From main\n\nMain's row.\n" },
      "docs(specs): other",
    );
    pr.mergeable = "CONFLICTING";
    q.script(
      reply(DESIGN, { "specs/web.md": `${SPEC["specs/web.md"]}\n### WEB-9 · From main\n\nMain's row.\n` }),
    );
    await q.until(() => q.claudeCalls.filter((c) => c.kind === "design").length === 2);
    pr.mergeable = "MERGEABLE";
    const after = await q.untilStage("approval:spec");
    const [, second] = q.claudeCalls.filter((c) => c.kind === "design");
    expect(second!.prompt).toContain("The spec PR conflicts with the base branch");
    expect(second!.prompt).toContain("conflict markers to resolve (keep both sides' rows): specs/web.md.");
    expect(second!.session.mode).toBe("resume");
    // The same PR got a commit with both rows and no markers.
    expect(q.prs.filter((x) => x.repo === "owner/web")).toHaveLength(1);
    const file = q.show("web", pr.head, "specs/web.md");
    expect(file).toContain("WEB-1");
    expect(file).toContain("WEB-9");
    expect(file).not.toContain("<<<<<<<");
    expect(after.spec_pr).toBe(pr.number);
    expect(q.stages(after.id)).toEqual(["design", "approval:spec", "design", "approval:spec"]);
    expect(JSON.parse(after.data).mergeMain).toBeUndefined();
  } finally {
    q.cleanup();
  }
}, 60_000);

test("pipeline: a spec conflict that stays waits for the owner", async () => {
  const r = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(r);
    await r.start();
    const m = await r.untilStage("approval:spec");
    r.prNo("web", m.spec_pr!).mergeable = "CONFLICTING";
    const blocked = await r.untilStage("blocked", 90);
    expect(blocked.waiting).toBe("spec conflict");
    // Two revisions were made, then the owner was asked.
    expect(r.claudeCalls.filter((c) => c.kind === "design")).toHaveLength(3);
    expect(JSON.parse(blocked.data).specConflicts).toBe(2);
  } finally {
    r.cleanup();
  }
}, 120_000);
