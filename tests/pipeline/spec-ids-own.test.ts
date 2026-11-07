// An intent's own spec rows are never renumbered (PIP-131, PIP-202): at pick, reserved IDs that its own
// merged or open spec PR wrote, or that it names as already written, stay; another intent's rows still move.

import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { namedAsWritten, ownSpecBranch } from "../../src/specids.ts";
import { DESIGN, DIR, happy, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const row = (id: string, name = "Greeting") => `### ${id} · ${name}\n\nThe page says hello.\n`;
const rows = (...ids: string[]) => ({
  "specs/earlier.md": `# Earlier\n\n${ids.map((i) => row(i, "Earlier")).join("\n")}`,
});
const OWN = "towercab/261026-1000-earlier-spec";
const designCalls = (p: Pipe) => p.claudeCalls.filter((c) => c.kind === "design");
const intentFile = (p: Pipe) => p.show("intents", "main", `${DIR}/intent.md`);
const commits = (p: Pipe) =>
  execFileSync("git", ["-C", p.bares.intents!, "log", "--format=%s", "main"], { encoding: "utf8" });

/** The design writes a row of its own; the reserved IDs are only what the pick decided. */
function writesOther(p: Pipe) {
  p.respond.design = reply(
    { ...DESIGN, spec_ids: ["WEB-9"], pr: "Adds WEB-9: the page greets visitors." },
    { "specs/web.md": `# Web\n\n${row("WEB-9")}` },
  );
}

/** A pipe that picks the intent with `setup` done on its repo first, and runs to the spec approval. */
async function picked(body: string, setup: (p: Pipe) => void, base = TARGET) {
  const p = new Pipe(base, intents(intent({ a: 2, body })), { keep: true });
  happy(p);
  writesOther(p);
  setup(p);
  await p.start();
  await p.untilStage("approval:spec");
  return p;
}

const RESERVED = "- spec IDs: WEB-1..2\n";

describe("own spec PR heads", () => {
  test("pipeline: a spec PR head is matched by the intent id prefix and the -spec suffix", () => {
    expect(ownSpecBranch("261026-1000", "towercab/261026-1000-show-a-greeting-spec")).toBe(true);
    expect(ownSpecBranch("261026-1000", "towercab/261026-1000-show-a-greeting-2-spec")).toBe(true);
    expect(ownSpecBranch("261026-1000", "towercab/261026-1000-spec")).toBe(true);
    expect(ownSpecBranch("261026-1000", "towercab/261026-1000-show-a-greeting")).toBe(false);
    expect(ownSpecBranch("261026-1000", "towercab/261026-1100-show-a-greeting-spec")).toBe(false);
    expect(ownSpecBranch("261026-1000", "feature/261026-1000-show-a-greeting-spec")).toBe(false);
  });

  test("an intent's own words name IDs as already written", () => {
    const text = "- spec IDs: WEB-1..4\n- WEB-3..4 are already written; make them Live\n";
    expect(namedAsWritten(text)).toEqual(["WEB-3", "WEB-4"]);
    expect(namedAsWritten("- spec IDs: WEB-1..4\n")).toEqual([]);
  });
});

describe("reserved IDs the intent wrote itself", () => {
  describe("merged spec PR", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked(RESERVED, (q) => {
        q.mergePr(q.openOtherPr("web", "towercab/261026-1000-earlier-spec", rows("WEB-1", "WEB-2")));
      });
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: reserved IDs from the intent's own merged spec PR are kept", () => {
      expect(designCalls(p)[0]!.prompt).toContain("Use only these reserved requirement IDs: WEB-1..2.");
      expect(designCalls(p)[0]!.prompt).toContain("already rows on the base branch");
      expect(intentFile(p)).toContain("- spec IDs: WEB-1..2\n");
      expect(commits(p)).not.toContain("renumber spec IDs");
      expect(JSON.parse(p.mission()!.data).idsRenumbered).toBeUndefined();
    });
  });

  describe("open spec PR", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked(RESERVED, (q) => {
        q.openOtherPr("web", "towercab/261026-1000-earlier-spec", rows("WEB-1", "WEB-2"));
      });
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: reserved IDs from the intent's own open spec PR are kept", () => {
      expect(designCalls(p)[0]!.prompt).toContain("Use only these reserved requirement IDs: WEB-1..2.");
      expect(intentFile(p)).toContain("- spec IDs: WEB-1..2\n");
      expect(JSON.parse(p.mission()!.data).idsRenumbered).toBeUndefined();
    });
  });

  describe("named as already written", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked("- spec IDs: WEB-1..2 (already written; make them Live)\n", () => {}, {
        ...TARGET,
        "specs/old.md": `# Old\n\n${row("WEB-1", "Old")}\n${row("WEB-2", "Old")}`,
      });
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: reserved IDs the intent names as already written are kept", () => {
      expect(intentFile(p)).toContain("- spec IDs: WEB-1..2 (already written; make them Live)\n");
      expect(JSON.parse(p.mission()!.data).idsRenumbered).toBeUndefined();
    });
  });
});

describe("reserved IDs that are not the intent's own", () => {
  describe("another intent's spec PR", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked(RESERVED, (q) => {
        q.mergePr(q.openOtherPr("web", "towercab/261026-0900-one-spec", rows("WEB-1")));
      });
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: reserved IDs that belong to another intent's rows are still moved", () => {
      expect(JSON.parse(p.mission()!.data).idsRenumbered).toEqual({ "WEB-1": "WEB-2", "WEB-2": "WEB-3" });
      expect(intentFile(p)).toContain("- spec IDs: WEB-2..3\n");
    });
  });

  describe("a sibling intent's spec PR", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked(RESERVED, (q) => {
        q.openOtherPr("web", "towercab/261026-1000-2-other-title-spec", rows("WEB-1", "WEB-2"));
      });
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: a sibling intent's spec PR head is not matched", () => {
      expect(JSON.parse(p.mission()!.data).idsRenumbered).toEqual({ "WEB-1": "WEB-3", "WEB-2": "WEB-4" });
    });
  });

  describe("rows on main from no intent", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked(RESERVED, () => {}, { ...TARGET, "specs/old.md": `# Old\n\n${row("WEB-1", "Old")}` });
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: reserved IDs on main that belong to no intent are still moved", () => {
      expect(JSON.parse(p.mission()!.data).idsRenumbered).toEqual({ "WEB-1": "WEB-2", "WEB-2": "WEB-3" });
    });
  });
});

describe("merged spec PRs that can't be read", () => {
  let p: Pipe;

  beforeAll(async () => {
    // WEB-1 came from the intent's own merged PR (unreadable), WEB-3 is named as already written.
    p = await picked(
      "- spec IDs: WEB-1..3\n- WEB-3 is already written; make it Live\n",
      (q) => {
        q.mergePr(q.openOtherPr("web", OWN, rows("WEB-1")));
        q.mergedListFails = true;
      },
      { ...TARGET, "specs/old.md": `# Old\n\n${row("WEB-3", "Old")}` },
    );
  }, 30_000);

  afterAll(() => p.cleanup());

  test("pipeline: unreadable merged spec PRs leave reserved IDs unmoved", () => {
    // Only what the intent itself names stays; the rest is moved as before, and the log says why.
    expect(JSON.parse(p.mission()!.data).idsRenumbered).toEqual({ "WEB-1": "WEB-4", "WEB-2": "WEB-5" });
    expect(intentFile(p)).toContain("WEB-3");
    expect(p.logs.some((l) => l.includes("IDs unchecked against merged spec PRs"))).toBe(true);
  });
});
