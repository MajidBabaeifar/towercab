// Intent names (INT-34): an intent the owner didn't write takes the design's plain title when it is
// picked up, keeping its old one; the owner's own titles are never changed.

import { expect, test } from "vitest";
import { DESIGN, DIR, happy, intent, intents, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const PLAIN = "Web greets every visitor as soon as the page opens";

async function designed(text: string): Promise<Pipe> {
  const p = new Pipe(TARGET, intents(text));
  happy(p);
  p.respond.design = reply({ ...DESIGN, title: `${PLAIN}.` }, SPEC);
  await p.start();
  const n = await p.until(() => p.mission()?.spec_pr != null, 30);
  expect(n, p.moves()).toBeGreaterThan(0);
  return p;
}

test("pipeline: an intent from elsewhere takes a plain title at pick", async () => {
  const before = intent({ title: "Fix greeting bug" }).replace("source: me", "source: issue");
  const p = await designed(before);
  try {
    const after = p.show("intents", "main", `${DIR}/intent.md`);
    // Only the title line changed, and the old title is kept in the body; every other line is as it was.
    const head = before.replace("# Intent: Fix greeting bug\n", `# Intent: ${PLAIN}\n`);
    const lines = (s: string) => s.split("\n").filter((l) => !/^(stage|waiting|spec_pr): /.test(l));
    expect(lines(after).slice(0, lines(head).length)).toEqual(lines(head));
    expect(after.endsWith("\n## Original title\n\nFix greeting bug\n")).toBe(true);
    // The spec PR already carries the new title.
    expect(p.prNo("web", p.mission()!.spec_pr!).title).toBe(`docs(specs): ${PLAIN}`);
  } finally {
    p.cleanup();
  }
}, 30_000);

test("pipeline: the owner's titles are never renamed", async () => {
  const p = await designed(intent({ title: "Show a greeting" }));
  try {
    const after = p.show("intents", "main", `${DIR}/intent.md`);
    expect(after).toContain("\n# Intent: Show a greeting\n");
    expect(after).not.toContain("Original title");
    expect(p.prNo("web", p.mission()!.spec_pr!).title).toBe("docs(specs): Show a greeting");
  } finally {
    p.cleanup();
  }
}, 30_000);
