// What the revision prompts ask for when the owner's comments started the run (PIP-205).

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { replySection } from "../src/pipeline/reply.ts";

const AGENTS = ["design", "plan", "worker", "repair"];

/** An agent file's text on one line per paragraph, so a wrapped sentence can be searched for. */
const text = (name: string) =>
  readFileSync(new URL(`../agents/${name}.md`, import.meta.url), "utf8").replace(/\s+/g, " ");

const section = replySection([
  { kind: "spec", id: "c1", thread: "", url: "", excerpt: "Add an empty page case." },
  { kind: "spec", id: "c2", thread: "", url: "", excerpt: "Name the greeting text." },
]);

test("prompts: revision prompts ask for a reply that answers each comment", () => {
  for (const name of AGENTS) {
    const t = text(name);
    expect(t, name).toContain("`reply`");
    expect(t, name).toContain("One part per comment, named by its id");
  }
  expect(section).toContain("`reply`");
  expect(section).toContain("one part for each comment, named by its id");
  expect(section).toContain("[c1] Add an empty page case.");
  expect(section).toContain("[c2] Name the greeting text.");
  expect(replySection(undefined)).toBe("");
});

test("prompts: the reply rules follow the writing guide", () => {
  for (const name of AGENTS) {
    const t = text(name);
    expect(t, name).toContain("written to the writing guide in plain words");
    expect(t, name).toContain("how you read the comment");
    expect(t, name).toContain("what you chose not to change, and why");
    expect(t, name).toContain("with your recommendation");
    expect(t, name).toContain("No step names or field names");
  }
  expect(section).toContain("written to the writing guide");
  expect(section).toContain("any new or still-open point with your recommendation");
});

test("prompts: a comment needing no change is answered Nothing to change", () => {
  for (const name of AGENTS) expect(text(name), name).toContain("`Nothing to change: <why>`");
  expect(section).toContain("`Nothing to change: <why>`");
});
