// PIP-201: a whole a5 flow reaches the code host only through `Forge`: no `gh` program is run, and the
// PRs of the three steps open and merge in order.

import { afterAll, beforeAll, expect, test } from "vitest";
import { build, CODE, DESIGN, intent, intents, PLAN, REVIEW, reply, SPEC } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

const CLAUDE_MD = `# Web

## Verifying your work

\`\`\`checks
sh -c 'for t in tests/*.sh; do sh "$t" || exit 1; done'
\`\`\`
`;

let p: Pipe;

beforeAll(async () => {
  p = new Pipe(
    { "CLAUDE.md": CLAUDE_MD, "tests/base.sh": "true\n", "README.md": "web\n" },
    intents(intent({ a: 5 })),
    { keep: true },
  );
  p.script(reply(DESIGN, SPEC), reply(PLAN), reply(build(), CODE), reply(REVIEW));
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
}, 60_000);

afterAll(() => p.cleanup());

test("forge: stages make the same host calls through Forge", () => {
  expect(p.mission()!.stage, p.moves()).toBe("done");
  expect(p.tools.calls.map((c) => c.cmd)).not.toContain("gh");
  const opened = p.forge.calls.filter((l) => l.startsWith("open "));
  const merged = p.forge.calls.filter((l) => l.startsWith("merge "));
  expect(opened.map((l) => l.split(" ")[1])).toEqual(["owner/web#1", "owner/intents#2", "owner/web#3"]);
  expect(merged.map((l) => l.split(" ")[1])).toEqual(["owner/web#1", "owner/intents#2", "owner/web#3"]);
  expect(p.forge.calls.indexOf(merged[0]!)).toBeLessThan(p.forge.calls.indexOf(opened[1]!));
});
