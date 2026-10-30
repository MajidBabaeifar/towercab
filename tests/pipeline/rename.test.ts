// Intent names (INT-34, INT-36): an intent the owner didn't write takes the design's plain title when it
// is picked up, keeping its old one, and its feature-list line follows; the owner's own titles are never
// changed. PR titles use the design's short subject (PIP-111).

import { expect, test } from "vitest";
import type { Intent } from "../../src/intents/types.ts";
import type { Mission } from "../../src/mission.ts";
import { commitTitle } from "../../src/pipeline/common.ts";
import { DESIGN, DIR, happy, ID, intent, intents, reply, SPEC, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const PLAIN = "Web greets every visitor as soon as the page opens";

const FEATURES = [
  "# web: what people can do",
  "",
  "<!-- the owner's note -->",
  "",
  "- [live]   People can sign in.",
  "",
].join("\n");

async function designed(text: string, design: Record<string, unknown> = {}): Promise<Pipe> {
  const p = new Pipe(TARGET, { ...intents(text), "features/web.md": FEATURES });
  happy(p);
  p.respond.design = reply({ ...DESIGN, title: `${PLAIN}.`, ...design }, SPEC);
  await p.start();
  const n = await p.until(() => p.mission()?.spec_pr != null, 30);
  expect(n, p.moves()).toBeGreaterThan(0);
  return p;
}

const fromIssue = (title: string) => intent({ title }).replace("source: me", "source: issue");

test("pipeline: an intent from elsewhere takes a plain title at pick", async () => {
  const before = fromIssue("Fix greeting bug");
  const p = await designed(before);
  try {
    const after = p.show("intents", "main", `${DIR}/intent.md`);
    // Only the title line changed, and the old title is kept in the body; every other line is as it was.
    const head = before.replace("# Intent: Fix greeting bug\n", `# Intent: ${PLAIN}\n`);
    const lines = (s: string) => s.split("\n").filter((l) => !/^(stage|waiting|spec_pr): /.test(l));
    expect(lines(after).slice(0, lines(head).length)).toEqual(lines(head));
    expect(after.endsWith("\n## Original title\n\nFix greeting bug\n")).toBe(true);
    // PIP-111: the spec PR is titled by the design's short subject, not the long title.
    expect(p.prNo("web", p.mission()!.spec_pr!).title).toBe("docs(specs): show a greeting");
  } finally {
    p.cleanup();
  }
}, 30_000);

test("pipeline: a renamed intent's feature line takes the new title", async () => {
  const p = await designed(fromIssue("Fix greeting bug"));
  try {
    // INT-36: the line pick added for it now reads the new title; its status, tag and every other line stay.
    expect(p.show("intents", "main", "features/web.md")).toBe(
      `${FEATURES}- [in progress] ${PLAIN} <!-- intent ${ID} -->\n`,
    );
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
    expect(p.show("intents", "main", "features/web.md")).toContain(
      `- [in progress] Show a greeting <!-- intent ${ID} -->`,
    );
  } finally {
    p.cleanup();
  }
}, 30_000);

test("pipeline: a design title is cleaned before it renames", async () => {
  const p = await designed(fromIssue("Fix greeting bug"), {
    title: "## <!-- hi --> @owner `Web` greets\u0007 every visitor\nas soon as the page opens.",
  });
  try {
    const after = p.show("intents", "main", `${DIR}/intent.md`);
    // No heading, comment, code span, mention or control character survives; one line.
    expect(after).toContain("\n# Intent: owner Web greets every visitor as soon as the page opens\n");
  } finally {
    p.cleanup();
  }
}, 30_000);

test("pipeline: a title that breaks the naming rule is not used", async () => {
  const p = await designed(fromIssue("Fix greeting bug"), { title: "Greeting fix" });
  try {
    const after = p.show("intents", "main", `${DIR}/intent.md`);
    expect(after).toContain("\n# Intent: Fix greeting bug\n");
    expect(after).not.toContain("Original title");
    expect(p.logs.join("\n")).toMatch(
      /kept its title: the design's \("Greeting fix" has 2 words, fewer than 4\)/,
    );
  } finally {
    p.cleanup();
  }
}, 30_000);

test("pipeline: PR titles use the design's short subject", () => {
  const m = (design: Record<string, unknown>) =>
    ({
      data: JSON.stringify({ design: { type: "feat", scope: "web", breaking: false, ...design } }),
    }) as Mission;
  const i = { title: "Web greets every visitor as soon as the page opens" } as Intent;
  expect(commitTitle(m({ subject: "Greet visitors" }), i)).toBe("feat(web): greet visitors");
  // Cleaned like a title: no mention, code span or trailing period; cut to a few words' length.
  expect(commitTitle(m({ subject: "@all `greet` visitors." }), i)).toBe("feat(web): all greet visitors");
  // A design from before subjects, or one that cleans to nothing: the intent's title, as before.
  expect(commitTitle(m({}), i)).toBe("feat(web): web greets every visitor as soon as the page opens");
  expect(commitTitle(m({ subject: " <> " }), i)).toBe(
    "feat(web): web greets every visitor as soon as the page opens",
  );
});
