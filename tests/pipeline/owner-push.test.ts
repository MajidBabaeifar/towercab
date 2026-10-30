// The owner pushes to the PR while it waits (PIP-2): Towercab merges their commits in, never
// force-pushes over them, and the gate sends a PR with someone else's commits to the owner.

import { afterAll, beforeAll, expect, test } from "vitest";
import { othersInHome } from "../../src/claude.ts";
import type { Mission } from "../../src/mission.ts";
import { build, CODE, checkRun, happy, ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let p: Pipe;
let m: Mission;
const branch = `towercab/${ID}-${SLUG}`;

beforeAll(async () => {
  p = new Pipe(TARGET, intents(intent({ a: 5 })), { keep: true });
  happy(p);
  let round = 0;
  p.respond.worker = () => {
    round++;
    return { structured: build(), edits: round === 1 ? CODE : { "greeting.txt": `hello, round ${round}\n` } };
  };
  await p.start();
  let fixed = false;
  await p.until(() => {
    const code = p.pr(branch);
    if (code && !fixed) code.checks = () => [checkRun("test", "FAILURE", 300 + p.prs.length)];
    return p.mission()?.stage === "blocked";
  });
  // CI stayed red: the owner pushes a fix to the PR and says so.
  const code = p.pr(branch)!;
  p.pushTo("web", branch, { "owner.txt": "the owner's fix\n" }, "owner: fix the flaky test");
  p.ownerComment(code, "Fixed the flaky test myself; carry on.");
  fixed = true;
  code.checks = () => [checkRun("test", "SUCCESS", 900)];
  m = await p.untilStage("approval:merge");
}, 60_000);

afterAll(() => p.cleanup());

test("pipeline: the owner's commits on the PR are kept", () => {
  expect(p.show("web", branch, "owner.txt")).toBe("the owner's fix\n");
  expect(p.show("web", branch, "greeting.txt")).toMatch(/^hello, round \d\n$/);
  expect(
    p.tools.lines("git").some((l) => l.includes("push") && l.includes("--force") && l.includes("towercab/")),
  ).toBe(false);
  // At a5 Towercab would merge on its own; with the owner's commits on the PR, the owner decides.
  expect([m.stage, m.why]).toEqual([
    "approval:merge",
    "Someone else added commits to the PR, so Towercab won't merge it on its own.",
  ]);
});

test("claude: other missions are unreadable", () => {
  const deny = othersInHome({
    cwd: p.home.abs(m.checkout),
    runsDir: p.home.runs(m.intent),
    cache: p.home.cache("web"),
  });
  expect(deny).toContain(p.home.abs("repos"));
  expect(deny).toContain(p.home.abs("intents"));
  expect(deny).toContain(p.home.abs("towercab.db"));
  expect(deny).not.toContain(p.home.abs(m.checkout));
  expect(deny).not.toContain(p.home.runs(m.intent));
});
