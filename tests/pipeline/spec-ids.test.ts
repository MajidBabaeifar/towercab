// Open spec PRs never share requirement IDs (PIP-130, PIP-131): the design reads the IDs other open PRs
// add, moves its own on a clash, and an intent's reserved IDs are checked at pick.

import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DESIGN, DIR, happy, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const row = (id: string, name = "Greeting") => `### ${id} · ${name}\n\nThe page says hello.\n`;
const specOf = (...ids: string[]) => `# Web\n\n${ids.map((i) => row(i)).join("\n")}`;
const other = (...ids: string[]) => ({
  "specs/other.md": `# Other\n\n${ids.map((i) => row(i, "Other")).join("\n")}`,
});
const approved = [{ author: "owner", state: "APPROVED", body: "", at: "2026-10-26T12:00:00Z", commit: "x" }];
const designCalls = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "design");

/** The agent writes `ids` and claims them, whatever the prompt said. */
function writes(p: Pipe, ...ids: string[]) {
  p.respond.design = reply(
    { ...DESIGN, spec_ids: ids, pr: `Adds ${ids.join(" and ")}: the page greets visitors.` },
    { "specs/web.md": specOf(...ids) },
  );
}

describe("taken IDs", () => {
  let p: Pipe;

  beforeAll(async () => {
    p = new Pipe(
      { ...TARGET, "specs/old.md": "# Old\n\n### OLD-9 · Old\n\nOld.\n" },
      intents(intent({ a: 2 })),
      {
        keep: true,
      },
    );
    happy(p);
    // Any open PR that adds requirement headings counts, whatever its branch is called.
    p.openOtherPr("web", "feature/more-specs", other("OTH-7", "OTH-8"));
    p.openOtherPr("web", "feature/code-only", { "src/x.txt": "x\n" });
    await p.start();
    await p.untilStage("approval:spec");
  }, 30_000);

  afterAll(() => p.cleanup());

  test("pipeline: design prompt lists IDs added by other open spec PRs", () => {
    const prompt = designCalls(p)[0]!.prompt;
    expect(prompt).toContain("IDs already taken by other open spec PRs (do not use them): OTH-7, OTH-8.");
    expect(prompt).toContain("The highest requirement number on the base branch, per prefix: OLD-9.");
  });
});

describe("a clash with open spec PRs", () => {
  let p: Pipe;

  beforeAll(async () => {
    p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
    happy(p);
    writes(p, "WEB-1");
    p.openOtherPr("web", "towercab/261026-0900-one-spec", {
      "specs/one.md": `# One\n\n${row("WEB-1", "One")}`,
    });
    p.openOtherPr("web", "towercab/261026-0901-two-spec", {
      "specs/two.md": `# Two\n\n${row("WEB-2", "Two")}`,
    });
    await p.start();
    await p.untilStage("approval:spec");
  }, 30_000);

  afterAll(() => p.cleanup());

  test("pipeline: second design takes the next free ID", () => {
    const m = p.mission()!;
    const pr = p.prNo("web", m.spec_pr!);
    // Two other open spec PRs hold WEB-1 and WEB-2: this design moves to WEB-3.
    const file = p.show("web", pr.head, "specs/web.md");
    expect(file).toContain("### WEB-3 · Greeting");
    expect(file).not.toContain("WEB-1");
    expect(designCalls(p)).toHaveLength(1);
  });

  test("pipeline: a renumbering updates the plan and PR body in the same revision", () => {
    const m = p.mission()!;
    const pr = p.prNo("web", m.spec_pr!);
    const d = JSON.parse(m.data);
    expect(d.design.specIds).toEqual(["WEB-3"]);
    expect(d.design.pr).toBe("Adds WEB-3: the page greets visitors.");
    expect(d.idsRenumbered).toEqual({ "WEB-1": "WEB-3" });
    // The PR was opened with the new number, so its body never named the old one.
    expect(pr.body).toContain("WEB-3");
    expect(pr.body).not.toContain("WEB-1");
    expect(p.logs.some((l) => l.includes("moved: WEB-1 → WEB-3"))).toBe(true);
  });
});

test("pipeline: the unapproved spec PR yields a clashing ID", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(p);
    writes(p, "WEB-1");
    // The other PR is the later one, but it is approved: approval decides before the order does.
    const o = p.openOtherPr("web", "towercab/261026-0900-one-spec", other("WEB-1"));
    o.number = 99;
    o.reviews = approved;
    await p.start();
    const m = await p.untilStage("approval:spec");
    const file = p.show("web", p.prNo("web", m.spec_pr!).head, "specs/web.md");
    expect(file).toContain("### WEB-2 · Greeting");
    expect(file).not.toContain("WEB-1");
  } finally {
    p.cleanup();
  }
}, 60_000);

test("pipeline: the later spec PR yields when both are unapproved", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(p);
    writes(p, "WEB-1");
    // The other PR is the earlier one and neither is approved: this one yields.
    p.openOtherPr("web", "towercab/261026-0900-one-spec", other("WEB-1"));
    await p.start();
    const m = await p.untilStage("approval:spec");
    const pr = p.prNo("web", m.spec_pr!);
    expect(p.show("web", pr.head, "specs/web.md")).toContain("### WEB-2 · Greeting");

    // A later PR now adds WEB-2 too. This one is earlier, so it keeps its ID when it is revised.
    const late = p.openOtherPr("web", "towercab/261026-0950-late-spec", other("WEB-2"));
    expect(late.number).toBeGreaterThan(pr.number);
    pr.mergeable = "CONFLICTING";
    writes(p, "WEB-2", "WEB-3");
    await p.until(() => designCalls(p).length === 2);
    pr.mergeable = "MERGEABLE";
    await p.untilStage("approval:spec");
    const file = p.show("web", pr.head, "specs/web.md");
    expect(file).toContain("### WEB-2 · Greeting");
    expect(file).toContain("### WEB-3 · Greeting");
  } finally {
    p.cleanup();
  }
}, 90_000);

test("pipeline: design goes on and is re-checked when open spec PRs cannot be listed", async () => {
  const p = new Pipe(TARGET, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(p);
    writes(p, "WEB-1");
    p.openOtherPr("web", "towercab/261026-0900-one-spec", other("WEB-1"));
    // GitHub fails to list the open PRs once, when the design starts.
    p.forge.failNext("openPrBranches", 1, "HTTP 502: bad gateway");
    await p.start();
    const m = await p.untilStage("approval:spec");
    const prompt = designCalls(p)[0]!.prompt;
    expect(prompt).toContain("IDs unchecked against open PRs");
    // Before the spec PR was opened, the IDs were read again: the clash was found and moved.
    expect(p.show("web", p.prNo("web", m.spec_pr!).head, "specs/web.md")).toContain("### WEB-2 · Greeting");
    const d = JSON.parse(m.data);
    expect(d.idsUnchecked).toBeUndefined();
    expect(d.design.concerns.map((c: { what: string }) => c.what)).not.toContain(
      "IDs unchecked against open PRs",
    );
    expect(p.logs.some((l) => l.includes("IDs unchecked against open PRs: "))).toBe(true);
  } finally {
    p.cleanup();
  }
}, 60_000);

describe("reserved IDs", () => {
  const ORIGINAL = intent({ a: 2, body: "- spec IDs: WEB-1..2\n" });
  const intentFile = (p: Pipe) => p.show("intents", "main", `${DIR}/intent.md`);
  const commits = (p: Pipe) =>
    execFileSync("git", ["-C", p.bares.intents!, "log", "--format=%s", "main"], { encoding: "utf8" });

  describe("taken", () => {
    let p: Pipe;

    beforeAll(async () => {
      // WEB-1 is on main, WEB-3 is added by an open PR: the reserved WEB-1..2 clashes.
      p = new Pipe({ ...TARGET, "specs/old.md": `# Old\n\n${row("WEB-1", "Old")}` }, intents(ORIGINAL), {
        keep: true,
      });
      happy(p);
      writes(p, "WEB-4", "WEB-5");
      p.openOtherPr("web", "towercab/261026-0900-one-spec", other("WEB-3"));
      await p.start();
      await p.untilStage("approval:spec");
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: reserved IDs that clash are renumbered at pick", () => {
      expect(designCalls(p)[0]!.prompt).toContain("Use only these reserved requirement IDs: WEB-4..5.");
      expect(JSON.parse(p.mission()!.data).idsRenumbered).toEqual({ "WEB-1": "WEB-4", "WEB-2": "WEB-5" });
      expect(
        p.logs.some((l) => l.includes("reserved spec IDs were taken, moved: WEB-1 → WEB-4, WEB-2 → WEB-5")),
      ).toBe(true);
    });

    test("pipeline: renumbered IDs are written back to the intent", () => {
      const file = intentFile(p);
      expect(file).toContain("- spec IDs: WEB-4..5\n");
      expect(file).not.toContain("WEB-1..2");
      // Only that line changed in the body.
      expect(file).toContain("## Proposed outcome\n- The page says hello\n- spec IDs: WEB-4..5\n");
      expect(commits(p)).toContain("towercab: renumber spec IDs");
    });
  });

  describe("free", () => {
    let p: Pipe;

    beforeAll(async () => {
      // WEB-5 is on main and WEB-7 is in an open PR: WEB-1..2 sits in a gap below them, and is free.
      p = new Pipe({ ...TARGET, "specs/old.md": `# Old\n\n${row("WEB-5", "Old")}` }, intents(ORIGINAL), {
        keep: true,
      });
      happy(p);
      writes(p, "WEB-1", "WEB-2");
      p.openOtherPr("web", "towercab/261026-0900-one-spec", other("WEB-7"));
      await p.start();
      await p.untilStage("approval:spec");
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: free reserved IDs leave the intent untouched", () => {
      expect(intentFile(p)).toContain("- spec IDs: WEB-1..2\n");
      expect(commits(p)).not.toContain("renumber spec IDs");
      expect(JSON.parse(p.mission()!.data).idsRenumbered).toBeUndefined();
    });

    test("pipeline: a reserved ID in a gap is kept when free", () => {
      expect(designCalls(p)[0]!.prompt).toContain("Use only these reserved requirement IDs: WEB-1..2.");
      const file = p.show("web", p.prNo("web", p.mission()!.spec_pr!).head, "specs/web.md");
      expect(file).toContain("### WEB-1 · Greeting");
      expect(file).toContain("### WEB-2 · Greeting");
    });

    test("pipeline: a reserved range in a gap is not renumbered", () => {
      expect(JSON.parse(p.mission()!.data).design.specIds).toEqual(["WEB-1", "WEB-2"]);
      expect(intentFile(p)).not.toContain("WEB-8");
    });
  });
});
