// An ID the intent words as already existing is a reference and is never moved (PIP-210); any other ID
// that is taken is moved as before (PIP-131).

import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { namedAsWritten } from "../../src/specids.ts";
import { DESIGN, DIR, happy, intent, intents, reply, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const row = (id: string, name = "Greeting") => `### ${id} · ${name}\n\nThe page says hello.\n`;
const rows = (...ids: string[]) => `# Old\n\n${ids.map((i) => row(i, "Old")).join("\n")}`;
const onMain = (...ids: string[]) => ({ ...TARGET, "specs/old.md": rows(...ids) });
const intentFile = (p: Pipe) => p.show("intents", "main", `${DIR}/intent.md`);
const renumbered = (p: Pipe) => JSON.parse(p.mission()!.data).idsRenumbered;
const commits = (p: Pipe) =>
  execFileSync("git", ["-C", p.bares.intents!, "log", "--format=%s", "main"], { encoding: "utf8" });

/** A pipe that picks the intent with `setup` done first, and runs to the spec approval. */
async function picked(body: string, base: Record<string, string>, setup: (p: Pipe) => void = () => {}) {
  const p = new Pipe(base, intents(intent({ a: 2, body })), { keep: true });
  happy(p);
  p.respond.design = reply(
    { ...DESIGN, spec_ids: ["WEB-9"], pr: "Adds WEB-9: the page greets visitors." },
    { "specs/web.md": `# Web\n\n${row("WEB-9")}` },
  );
  setup(p);
  await p.start();
  await p.untilStage("approval:spec");
  return p;
}

const OTHER = "towercab/261026-0900-one-spec";

describe("the wording of the intent", () => {
  test("pipeline: the clause wording marks the IDs it covers", () => {
    expect(namedAsWritten("- spec IDs: LOOP-76, LOOP-77, UI-164 are made true as written\n")).toEqual([
      "LOOP-76",
      "LOOP-77",
      "UI-164",
    ]);
    expect(namedAsWritten("- spec IDs: REPO-30..32 made true as written\n")).toEqual([
      "REPO-30",
      "REPO-31",
      "REPO-32",
    ]);
    expect(namedAsWritten("- spec IDs: WEB-1..2 (already written; make them Live)\n")).toEqual([
      "WEB-1",
      "WEB-2",
    ]);
    // A `;` ends the clause: the wording after it covers only its own IDs.
    expect(namedAsWritten("- WEB-1 is new; WEB-2 exists\n")).toEqual(["WEB-2"]);
    expect(namedAsWritten("- WEB-1 is existing\n- WEB-2 CHANGED\n")).toEqual(["WEB-1", "WEB-2"]);
    // Whole words only, and no wording means no reference.
    expect(namedAsWritten("- WEB-1 is unchanged and nonexistent\n")).toEqual([]);
    expect(namedAsWritten("- spec IDs: WEB-1..2\n")).toEqual([]);
  });
});

describe("references", () => {
  describe("made true as written", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked("- spec IDs: WEB-1..2 are made true as written\n", onMain("WEB-1", "WEB-2"));
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: reserved IDs the intent words as made true as written are kept", () => {
      expect(renumbered(p)).toBeUndefined();
      expect(intentFile(p)).toContain("- spec IDs: WEB-1..2 are made true as written\n");
      expect(commits(p)).not.toContain("renumber spec IDs");
    });
  });

  describe("already written or changed", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked(
        "- spec IDs: WEB-1, WEB-2\n- WEB-1 is already written\n- WEB-2 is changed\n",
        onMain("WEB-1", "WEB-2"),
      );
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: reserved IDs the intent words as already written or changed are kept", () => {
      expect(renumbered(p)).toBeUndefined();
      expect(intentFile(p)).toContain("- spec IDs: WEB-1, WEB-2\n");
    });
  });

  describe("an open spec PR adds it too", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked("- spec IDs: WEB-1..2 are made true as written\n", onMain("WEB-1", "WEB-2"), (q) => {
        q.openOtherPr("web", OTHER, { "specs/other.md": `# Other\n\n${row("WEB-1")}\n${row("WEB-2")}` });
      });
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: a reference is kept when an open spec PR adds it too", () => {
      expect(renumbered(p)).toBeUndefined();
      expect(intentFile(p)).toContain("- spec IDs: WEB-1..2 are made true as written\n");
    });
  });
});

describe("reservations and collisions", () => {
  describe("no wording", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked("- spec IDs: WEB-1..2\n", onMain("WEB-1"));
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: an ID on main with no reference wording is moved as a collision", () => {
      expect(renumbered(p)).toEqual({ "WEB-1": "WEB-2", "WEB-2": "WEB-3" });
      expect(intentFile(p)).toContain("- spec IDs: WEB-2..3\n");
    });
  });

  describe("claimed by another open spec PR", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked("- spec IDs: WEB-1..2\n", TARGET, (q) => {
        q.openOtherPr("web", OTHER, { "specs/other.md": `# Other\n\n${row("WEB-2")}` });
      });
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: a reserved ID another open spec PR claims is still moved", () => {
      expect(renumbered(p)).toEqual({ "WEB-1": "WEB-3", "WEB-2": "WEB-4" });
      expect(intentFile(p)).toContain("- spec IDs: WEB-3..4\n");
    });
  });

  describe("a line of both", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked("- spec IDs: WEB-1..2\n- WEB-1 is made true as written\n", onMain("WEB-1", "WEB-2"));
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: a line of references and reservations is split by its wording", () => {
      expect(renumbered(p)).toEqual({ "WEB-2": "WEB-3" });
      expect(intentFile(p)).toContain("- spec IDs: WEB-1, WEB-3\n");
    });
  });

  describe("a reference with no row on main", () => {
    let p: Pipe;

    beforeAll(async () => {
      p = await picked("- spec IDs: WEB-1..2\n- WEB-1 is already written\n", TARGET, (q) => {
        q.openOtherPr("web", OTHER, { "specs/other.md": `# Other\n\n${row("WEB-1")}` });
      });
    }, 30_000);

    afterAll(() => p.cleanup());

    test("pipeline: a reference with no row on main is treated as a reservation", () => {
      expect(renumbered(p)).toEqual({ "WEB-1": "WEB-2", "WEB-2": "WEB-3" });
    });
  });
});

describe("a base branch that can't be read", () => {
  let p: Pipe;

  beforeAll(async () => {
    p = await picked("- spec IDs: WEB-1..2\n", onMain("WEB-1"), (q) => {
      q.tools.grepFails = true;
    });
  }, 30_000);

  afterAll(() => p.cleanup());

  test("pipeline: an unreadable base branch leaves reserved IDs unmoved", () => {
    expect(renumbered(p)).toBeUndefined();
    expect(intentFile(p)).toContain("- spec IDs: WEB-1..2\n");
    expect(p.logs.some((l) => l.includes("IDs unchecked against main"))).toBe(true);
  });
});
