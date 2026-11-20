// A spec that adds a spec file also links it from the README's docs table (PIP-172); every other
// README edit of a design is discarded.

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { docsTableOnly } from "../../src/pipeline/docsindex.ts";
import { DESIGN, happy, intent, intents, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

const README = `# Web

Intro.

## Docs

| Spec | What it covers |
| --- | --- |
| [specs/web.md](specs/web.md) | The page |

Footer.
`;
const ROW = "| [specs/new.md](specs/new.md) | Something new |";
const WITH_ROW = README.replace("The page |\n", `The page |\n${ROW}\n`);
const NEW_SPEC = { ...SPEC, "specs/new.md": "# New\n\n### WEB-2 · New\n\nIt is new.\n" };

const BASE = { ...TARGET, "README.md": README, "specs/web.md": "# Web\n" };

/** Runs one design that writes `files`; returns the files of the spec PR and main's README. */
async function design(
  files: Record<string, string>,
): Promise<{ changed: string[]; diff: string; main: string }> {
  const p = new Pipe(BASE, intents(intent({ a: 2 })), { keep: true });
  try {
    happy(p);
    p.respond.design = reply(DESIGN, files);
    const seed = git(p.bares.web!, "rev-parse", "main").trim();
    await p.start();
    const m = await p.untilStage("approval:spec");
    const head = p.prNo("web", m.spec_pr!).head;
    return {
      changed: git(p.bares.web!, "diff", "--name-only", seed, head).trim().split("\n"),
      diff: git(p.bares.web!, "diff", seed, head, "--", "README.md"),
      main: p.show("web", "main", "README.md"),
    };
  } finally {
    p.cleanup();
  }
}

test("pipeline: a design that adds a spec file may edit the README docs table", async () => {
  const r = await design({ ...NEW_SPEC, "README.md": WITH_ROW });
  expect(r.changed).toEqual(["README.md", "specs/new.md", "specs/web.md"]);
  expect(r.diff.split("\n").filter((l) => /^[+-][^+-]/.test(l))).toEqual([`+${ROW}`]);
  expect(r.main).toBe(README);
}, 60_000);

test("pipeline: the publish guard accepts the README docs table for a new spec file", async () => {
  // The spec PR is opened and the mission reaches the owner's approval instead of stopping.
  const r = await design({ ...NEW_SPEC, "README.md": WITH_ROW });
  expect(r.changed).toContain("README.md");
  const agent = readFileSync("agents/design.md", "utf8");
  expect(agent).toContain('"Edit(README.md)"');
  expect(agent).toContain("add one row per new spec file to that table");
}, 60_000);

test("pipeline: other README edits in a design are still refused", async () => {
  for (const readme of [
    `${WITH_ROW}more\n`,
    WITH_ROW.replace("Intro.", "Changed."),
    WITH_ROW.replace("The page |", "Another |"),
    WITH_ROW.replace("## Docs", "## Documents"),
  ]) {
    const r = await design({ ...NEW_SPEC, "README.md": readme });
    expect(r.changed).toEqual(["specs/new.md", "specs/web.md"]);
    expect(r.main).toBe(README);
  }
}, 120_000);

test("pipeline: a README docs table edit without a new spec file is refused", async () => {
  const r = await design({ ...SPEC, "README.md": WITH_ROW });
  expect(r.changed).toEqual(["specs/web.md"]);
}, 60_000);

test("docsTableOnly: only added rows of the docs table pass", () => {
  expect(docsTableOnly(README, README)).toBe(true);
  expect(docsTableOnly(README, WITH_ROW)).toBe(true);
  // Edited, removed, reordered rows.
  expect(docsTableOnly(README, WITH_ROW.replace("The page", "A page"))).toBe(false);
  expect(docsTableOnly(WITH_ROW, README)).toBe(false);
  const two = WITH_ROW.replace(ROW, `${ROW}\n| [specs/b.md](specs/b.md) | B |`);
  const swapped = two.replace(
    `| [specs/web.md](specs/web.md) | The page |\n${ROW}`,
    `${ROW}\n| [specs/web.md](specs/web.md) | The page |`,
  );
  expect(docsTableOnly(README, swapped)).toBe(true);
  expect(docsTableOnly(two, swapped.replace(ROW, "| x |"))).toBe(false);
  // Outside the table, or the header.
  expect(docsTableOnly(README, `${WITH_ROW}x`)).toBe(false);
  expect(docsTableOnly(README, WITH_ROW.replace("Footer.", "Other."))).toBe(false);
  expect(docsTableOnly(README, WITH_ROW.replace("| Spec |", "| Name |"))).toBe(false);
  // No docs heading or no table.
  expect(docsTableOnly("# Web\n", "# Web\n| a |\n")).toBe(false);
  expect(docsTableOnly("# Web\n\n## Docs\n\nText.\n", "# Web\n\n## Docs\n\n| a |\n")).toBe(false);
});
