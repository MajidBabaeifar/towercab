// Branches left over on GitHub and branches of closed PRs (PIP-85..89, PIP-2): a refused push is a
// question, a leftover branch of Towercab's own is replaced, and a closed PR's branch is deleted.

import { expect, test } from "vitest";
import { insertCommand } from "../../src/commands.ts";
import { deleteBranch, retireBranch } from "../../src/github/branches.ts";
import { realTools } from "../../src/tools.ts";
import { happy, ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { okResult } from "../helpers/tools.ts";

const BRANCH = `towercab/${ID}-${SLUG}`;

/** A world with the happy-path Claude, at autonomy `a`. */
function world(a: number): Pipe {
  const p = new Pipe(TARGET, intents(intent({ a })));
  happy(p);
  return p;
}

const question = (p: Pipe) => JSON.parse(p.mission()!.data).question as { context: string };

/** The leftover branch of an earlier attempt: its commit on GitHub, its PR (open, by `author`). */
function leftover(p: Pipe, author = "towercab[bot]") {
  const pr = p.openOtherPr("web", BRANCH, { "old.txt": "v1\n" }, true, author);
  return { pr, head: p.headSha("owner/web", BRANCH) };
}

test("pipeline: a leftover App PR is closed and replaced", async () => {
  const p = world(5);
  const { pr: old } = leftover(p);
  await p.start();
  await p.until(() => p.mission()?.stage === "done");
  expect(p.mission()!.stage, p.moves()).toBe("done");
  expect(old.state).toBe("CLOSED");
  expect(old.comments.at(-1)!.body).toMatch(/started this intent over/);
  expect(p.deleted).toContain(`owner/web ${BRANCH}`);
  // The new attempt's PR carries the branch, and nothing of the old commit is left on it.
  const now = p.prs.find((x) => x.head === BRANCH && x !== old)!;
  expect(now.state).toBe("MERGED");
  expect(p.show("web", BRANCH, "greeting.txt")).toBe("hello\n");
  expect(() => p.show("web", BRANCH, "old.txt")).toThrow();
}, 60_000);

test("pipeline: someone else's branch is left alone", async () => {
  const p = world(5);
  const { pr, head } = leftover(p, "somebody-else");
  await p.start();
  const m = await p.untilStage("blocked");
  expect(m.waiting).toBe("answer the question");
  expect(pr.state).toBe("OPEN");
  expect(p.headSha("owner/web", BRANCH)).toBe(head);
  expect(p.deleted).toEqual([]);
  expect(question(p).context).toContain(BRANCH);
  expect(question(p).context).toContain("already has commits on that branch that Towercab doesn't");
  expect(question(p).context).toContain(`/pull/${pr.number}`);
  expect(p.prs.filter((x) => x.head === BRANCH)).toHaveLength(1);
}, 60_000);

test("pipeline: a leftover branch with commits but no PR waits", async () => {
  const p = world(5);
  const { pr, head } = leftover(p);
  p.prs.splice(p.prs.indexOf(pr), 1);
  await p.start();
  const m = await p.untilStage("blocked");
  expect(m.waiting).toBe("answer the question");
  expect(p.headSha("owner/web", BRANCH)).toBe(head);
  expect(p.deleted).toEqual([]);
  expect(question(p).context).toContain(BRANCH);
}, 60_000);

/** A branch GitHub gained after Towercab looked: the check sees nothing, the push is refused. */
function refusedWorld(): Pipe {
  const p = world(5);
  const { pr } = leftover(p);
  p.prs.splice(p.prs.indexOf(pr), 1);
  const real = realTools();
  p.tools.on("git", (args, opts) =>
    args.includes("ls-remote") ? okResult("") : real.run("git", args, opts),
  );
  return p;
}

const pushes = (p: Pipe) =>
  p.tools.calls.filter(
    (c) =>
      c.cmd === "git" && c.args.includes("push") && c.args.some((a) => a.endsWith(`:refs/heads/${BRANCH}`)),
  );

test("pipeline: a refused push waits with the reason", async () => {
  const p = refusedWorld();
  const { head } = { head: p.headSha("owner/web", BRANCH) };
  await p.start();
  const m = await p.untilStage("blocked");
  expect(m.waiting).toBe("answer the question");
  // Three tries, then the question: it names the branch and says GitHub has commits Towercab doesn't.
  expect(pushes(p)).toHaveLength(3);
  expect(question(p).context).toContain(BRANCH);
  expect(question(p).context).toContain("already has commits on that branch that Towercab doesn't");
  expect(p.headSha("owner/web", BRANCH)).toBe(head);
  expect(p.deleted).toEqual([]);
}, 60_000);

test("pipeline: a refused push is not counted as a crash", async () => {
  const p = refusedWorld();
  await p.start();
  const m = await p.untilStage("blocked");
  expect(p.db.all("SELECT id FROM transitions WHERE mission = ? AND event = 'crash'", m.id)).toEqual([]);
  expect(m.unclean).toBe(0);
  expect(m.waiting).not.toMatch(/^crashed at/);
}, 60_000);

/** An a2 intent held at the spec PR, for the tests that end it there. */
async function atSpec() {
  const p = world(2);
  await p.start();
  const m = await p.untilStage("approval:spec");
  return { p, m, pr: p.prNo("web", m.spec_pr!), spec: `${BRANCH}-spec` };
}

const settled = (p: Pipe) => () => p.mission()?.stage === "stopped" && p.mission()?.step !== "enter";

test("pipeline: a PR the owner closes loses its branch", async () => {
  const { p, pr, spec } = await atSpec();
  pr.state = "CLOSED";
  await p.until(settled(p));
  expect(p.mission()!.stage, p.moves()).toBe("stopped");
  expect(p.deleted).toEqual([`owner/web ${spec}`]);
  expect(() => p.headSha("owner/web", spec)).toThrow();
}, 60_000);

test("pipeline: drop deletes the PR's branch", async () => {
  const { p, pr, spec } = await atSpec();
  insertCommand(p.db, { name: "drop", arg: ID, text: "", source: "cli" }, p.clock.now());
  await p.until(settled(p));
  expect(p.mission()!.stage, p.moves()).toBe("stopped");
  expect(pr.state).toBe("CLOSED");
  expect(pr.comments.at(-1)!.body).toMatch(/intent was dropped/);
  expect(p.deleted).toEqual([`owner/web ${spec}`]);
}, 60_000);

test("pipeline: a failed branch delete is retried", async () => {
  const { p, pr, spec } = await atSpec();
  p.deleteFail = () => "gh: HTTP 500 Server Error";
  pr.state = "CLOSED";
  for (let i = 0; i < 4; i++) {
    await p.loop.pass();
    p.clock.advance(61);
  }
  // The stop is recorded, the delete is still due: the mission sits at its entry step.
  expect(p.mission()!.stage).toBe("stopped");
  expect(p.mission()!.step).toBe("enter");
  expect(p.deleted).toEqual([]);
  p.deleteFail = null;
  await p.until(settled(p));
  expect(p.deleted).toEqual([`owner/web ${spec}`]);
}, 60_000);

test("pipeline: a branch outside towercab/ is never deleted", async () => {
  const p = world(5);
  const gh = p.github();
  const other = p.openOtherPr("web", "feature/greeting", { "f.txt": "x\n" });
  other.state = "CLOSED";
  expect(await retireBranch(gh, "owner/web", other.number, null)).toBeNull();
  await expect(deleteBranch(gh, "owner/web", "main", null)).rejects.toThrow(/not a Towercab branch/);
  await expect(deleteBranch(gh, "owner/web", "plan/x", null)).rejects.toThrow(/not a Towercab branch/);
  // A Towercab branch, but its PR is someone else's, still open, or merged.
  const theirs = p.openOtherPr("web", "towercab/x-theirs", { "t.txt": "x\n" }, true, "somebody-else");
  theirs.state = "CLOSED";
  expect(await retireBranch(gh, "owner/web", theirs.number, null)).toBeNull();
  const open = p.openOtherPr("web", "towercab/x-open", { "o.txt": "x\n" });
  expect(await retireBranch(gh, "owner/web", open.number, null)).toBeNull();
  const merged = p.openOtherPr("web", "towercab/x-merged", { "m.txt": "x\n" });
  merged.state = "MERGED";
  expect(await retireBranch(gh, "owner/web", merged.number, null)).toBeNull();
  // A closed PR whose branch a newer open PR still uses keeps it; the App's own closed PR loses it.
  const old = p.openOtherPr("web", "towercab/x-shared", { "s.txt": "x\n" });
  old.state = "CLOSED";
  const newer = p.openOtherPr("web", "towercab/x-shared", {}, false);
  expect(await retireBranch(gh, "owner/web", old.number, null)).toBeNull();
  newer.state = "CLOSED";
  expect(await retireBranch(gh, "owner/web", old.number, null)).toBe("towercab/x-shared");
  expect(p.deleted).toEqual(["owner/web towercab/x-shared"]);
});
