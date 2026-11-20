// Spec rows that call something parked cite a parked intent from the README's Parked table (PIP-215).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const INTENT_ID = /\b\d{6}-\d{4}(?:-\d+)?\b/g;
const SPEC_ID = /\b[A-Z]{2,5}-\d+\b/g;
/** A sentence that calls something parked, not the priority state ("would be parked", the Parked list). */
const CALLS_PARKED =
  /\bparked (?:as|with|in|for)\b|\b(?:is|are|stays?|was|were) parked\b|\(parked[,)]|\bboth parked\b|\bthe parked self-monitoring\b/i;
/** The priority state (PRI-5) is not a removed feature: "the intent is parked", "shown as parked". */
const PRIORITY_STATE = /\bcutoff\b|\bintent is parked\b|\bshow it as parked\b|\bwhat is parked\b/i;
/** A sentence that only cites an intent as an origin or an example is left alone. */
const ORIGIN = /\b(?:replaces|replaced|e\.g\.|for example)\b/i;

interface Unit {
  label: string;
  text: string;
}

function withoutFences(md: string): string {
  return md.replace(/^```[\s\S]*?^```/gm, "");
}

/** The README's own table is read line by line; other files are cut at their `##` and `###` headings. */
function units(file: string, md: string): Unit[] {
  if (file === "README.md") {
    return withoutFences(md)
      .split("\n")
      .filter((l) => l.startsWith("| ["))
      .map((l) => ({ label: `README ${/\[([^\]]+)\]/.exec(l)![1]}`, text: l }));
  }
  return withoutFences(md)
    .split(/^(?=#{2,3} )/m)
    .map((part) => {
      const head = /^#{2,3} (.*)/.exec(part);
      if (!head) return { label: file, text: part };
      const id = /^### (\S+) /.exec(part);
      return { label: id ? id[1]! : `${file} ${head[1]}`, text: part };
    });
}

function sentences(text: string): string[] {
  return text
    .replace(/`[^`]*`/g, "")
    .split(/\n\s*\n|\n\s*- |\n\s*\d+\. /)
    .flatMap((p) =>
      p
        .replace(/\s+/g, " ")
        .trim()
        .split(/(?<=[.!?])\s+(?=[A-Z(])/),
    )
    .filter(Boolean);
}

function parkedTable(readme: string): Set<string> {
  const section = /^## Parked$([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(readme)?.[1] ?? "";
  return new Set([...section.matchAll(/^\|\s*(\d{6}-\d{4}-\d+)\s*\|/gm)].map((m) => m[1]!));
}

/** Every problem the rule finds in `files` (file name → markdown, `README.md` included). */
function parkedProblems(files: Record<string, string>): string[] {
  const parked = parkedTable(files["README.md"] ?? "");
  const headings = new Set<string>();
  for (const md of Object.values(files)) {
    for (const m of withoutFences(md).matchAll(/^### (\S+) /gm)) headings.add(m[1]!);
  }
  const problems: string[] = [];
  for (const [file, md] of Object.entries(files)) {
    for (const u of units(file, md)) {
      // The row that defines the rule quotes the phrases it looks for.
      if (u.label === "PIP-215") continue;
      for (const s of sentences(u.text)) {
        if (
          (CALLS_PARKED.test(s) && !ORIGIN.test(s) && !PRIORITY_STATE.test(s)) ||
          /^Removed\b.*\bdeferred\b/i.test(s)
        ) {
          const ids = s.match(INTENT_ID) ?? [];
          if (ids.length === 0) problems.push(`${u.label}: says parked without an intent id`);
          for (const id of ids)
            if (!parked.has(id)) problems.push(`${u.label}: cites ${id}, which is not parked`);
        }
        const by = /^Removed\b.*?\b(?:replaced|superseded) by ([^.]*)/i.exec(s)?.[1];
        for (const id of by?.match(SPEC_ID) ?? []) {
          if (!headings.has(id)) problems.push(`${u.label}: replaced by ${id}, which does not exist`);
        }
      }
    }
  }
  return problems;
}

const README =
  "## Parked\n\n| Intent | What it holds |\n|---|---|\n| 261026-2204-5 | Grafana export |\n\n## Areas\n";

test("specs: parked rows cite a parked intent", () => {
  const files: Record<string, string> = {};
  for (const f of readdirSync("specs")) {
    if (f.endsWith(".md") && !f.startsWith("_")) files[f] = readFileSync(join("specs", f), "utf8");
  }
  expect(parkedProblems(files)).toEqual([]);
});

test("specs: a row that says parked without an intent id fails", () => {
  const md = "### XX-1 · Old\n\nRemoved: the thing is parked.\n";
  expect(parkedProblems({ "README.md": README, "x.md": md })).toEqual([
    "XX-1: says parked without an intent id",
  ]);
});

test("specs: a row that cites an intent missing from the Parked table fails", () => {
  const md = "### XX-1 · Old\n\nRemoved: parked as intent 261026-2204-4.\n";
  expect(parkedProblems({ "README.md": README, "x.md": md })).toEqual([
    "XX-1: cites 261026-2204-4, which is not parked",
  ]);
});

test("specs: a row that cites a parked intent passes", () => {
  const md = "### XX-1 · Old\n\nRemoved: parked as\nintent 261026-2204-5.\n";
  expect(parkedProblems({ "README.md": README, "x.md": md })).toEqual([]);
});

test("specs: a removed row replaced by an unknown id fails", () => {
  const md = "### XX-1 · Old\n\nRemoved: replaced by XX-2.\n\n### XX-3 · Old\n\nRemoved: replaced by XX-1.\n";
  expect(parkedProblems({ "README.md": README, "x.md": md })).toEqual([
    "XX-1: replaced by XX-2, which does not exist",
  ]);
});

test("specs: taking an intent out of the Parked table lists the rows that cite it", () => {
  const md =
    "### XX-1 · A\n\nRemoved: parked as intent 261026-2204-5.\n\n### XX-2 · B\n\nRemoved: parked with it (261026-2204-5).\n";
  const emptied = README.replace("| 261026-2204-5 | Grafana export |\n", "");
  expect(parkedProblems({ "README.md": emptied, "x.md": md })).toEqual([
    "XX-1: cites 261026-2204-5, which is not parked",
    "XX-2: cites 261026-2204-5, which is not parked",
  ]);
});

test("specs: a sentence that cites an intent only as an origin or the priority state is left alone", () => {
  const md =
    "### XX-1 · A\n\nIt replaces the parked self-monitoring (intent 261026-2204-2).\n\n### XX-2 · B\n\nAn intent below the cutoff is shown as would be parked; `parked` waits.\n";
  expect(parkedProblems({ "README.md": README, "x.md": md })).toEqual([]);
});
