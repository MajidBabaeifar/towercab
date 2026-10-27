// The /intent skill (INT-9): front matter and the template's sections.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("intents: the skill forbids fence markers in prose", () => {
  const skill = readFileSync(join(import.meta.dirname, "../../skills/intent/SKILL.md"), "utf8");
  expect(skill).toContain("Never start a prose or bullet line with three backticks or three tildes");
});

test("intents: the skill names every section", () => {
  const skill = readFileSync(join(import.meta.dirname, "../../skills/intent/SKILL.md"), "utf8");
  expect(skill.startsWith("---\n")).toBe(true);
  const meta = parse(skill.split("\n---\n")[0]!.slice(4)) as { name?: string; description?: string };
  expect(meta.name).toBe("intent");
  expect(meta.description?.length ?? 0).toBeGreaterThan(40);
  for (const must of [
    "## Problem",
    "## Proposed outcome",
    "## Affected users and systems",
    "## Constraints",
    "## Open questions",
    "# Intent: <title>",
    "source: me",
    "**Scope**",
    "**What success looks like**",
    "Leave `a` out",
    "docs(intents): add <id> <title>",
    "intents/<id>-<slug>/intent.md",
  ]) {
    expect(skill, must).toContain(must);
  }
});
