// Labels checked against the intents (INT-60..62): an issue labelled queued or proposed must have an
// intent or an open proposal behind it. Same world as issues.test.ts: the real store over a local bare
// repo, a fake `gh` and a fake `claude` that scores.

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type IssueDeps, PROPOSED_LABEL, pollIssues, QUEUED_LABEL } from "../../src/github/issues.ts";
import { TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

const SCORE = {
  u: 4,
  u_why: "Visitors hit it on every page.",
  i: 3,
  i_why: "One page is affected.",
  title: "Show a greeting",
  problem: "The page greets nobody.",
  outcome: ["The page says hello"],
  affected: "",
  constraints: [],
  open_questions: [],
};
const scored =
  (o: Record<string, unknown> = {}) =>
  () => ({ structured: { ...SCORE, ...o } });

async function world() {
  const p = new Pipe(TARGET, {});
  await p.start({}, { handlers: {} });
  await p.loop.issuesIdle();
  const deps = (): IssueDeps => ({
    config: p.config(),
    home: p.home,
    tools: p.tools,
    clock: p.clock,
    store: p.store,
    github: p.github(),
    log: (l) => p.logs.push(l),
    busy: () => new Set(),
    userHome: "/home/me",
  });
  return { p, deps, poll: () => pollIssues(deps()) };
}

const proposals = (p: Pipe) => p.prs.filter((x) => x.repo === "owner/intents" && x.head.startsWith("issue/"));

/** A queued issue by the owner whose label `who` set. */
const queued = (p: Pipe, who: string) =>
  p.issue({ labels: [QUEUED_LABEL], labeledBy: { [QUEUED_LABEL]: who } });

test("issues: a labelled issue with an intent is left alone", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  p.mergePr(proposals(p)[0]!);
  await poll();
  const before = { comments: [...it.comments], labels: [...it.labels], calls: p.claudeCalls.length };
  await poll();
  expect(it.labels).toContain(QUEUED_LABEL);
  expect({ comments: it.comments, labels: it.labels, calls: p.claudeCalls.length }).toEqual(before);
  expect(proposals(p)).toHaveLength(1);
});

test("issues: an issue with an open proposal is left alone", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  const before = { comments: [...it.comments], labels: [...it.labels] };
  await poll();
  expect({ comments: it.comments, labels: it.labels }).toEqual(before);
  expect(it.labels).toEqual([PROPOSED_LABEL]);
  expect(proposals(p)).toHaveLength(1);
});

test("issues: a failed read skips the label check", async () => {
  const { p, deps } = await world();
  p.queue("score", scored());
  const it = queued(p, "someone");
  const d = deps();
  const github = {
    ...d.github,
    gh: (repo: string, args: string[], o?: never) =>
      args[0] === "pr" && args[1] === "list"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "HTTP 502" })
        : d.github.gh(repo, args, o),
  } as IssueDeps["github"];
  await expect(pollIssues({ ...d, github })).rejects.toThrow(/gh pr list/);
  expect(proposals(p)).toEqual([]);
  expect(it.comments).toEqual([]);
  expect(it.labels).toEqual([QUEUED_LABEL]);
  expect(p.claudeCalls).toEqual([]);
});

test("issues: a queued issue with no intent is proposed once", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored());
  const it = queued(p, "someone");
  await poll();
  await poll();
  await poll();
  expect(p.claudeCalls).toHaveLength(1);
  expect(proposals(p)).toHaveLength(1);
  expect(it.labels).toEqual([PROPOSED_LABEL]);
  expect(it.comments).toHaveLength(1);
  expect(it.comments[0]).toContain("pull request");
});

test("issues: a queued label set by someone else is proposed", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  queued(p, "stranger");
  await poll();
  expect(proposals(p)).toHaveLength(1);
  expect((await p.store.list()).open).toEqual([]);
});

test("issues: an owner-labelled queued issue is written to main", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored());
  const it = queued(p, "Owner");
  await poll();
  await poll();
  expect(proposals(p)).toEqual([]);
  const l = await p.store.list();
  expect(l.open.map((i) => i.title)).toEqual(["Show a greeting"]);
  expect(l.open[0]!.issue).toBe("https://github.com/owner/web/issues/1");
  expect(it.labels).toEqual([QUEUED_LABEL]);
  expect(it.comments).toHaveLength(1);
  expect(it.comments[0]).toContain("queued");
  expect(p.claudeCalls).toHaveLength(1);
});

test("issues: a lost intent is proposed again and says so", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored());
  const it = p.issue();
  await poll();
  const first = proposals(p)[0]!;
  p.mergePr(first);
  // The merged intent's folder disappears from main.
  const work = join(p.dir("tc-lost-"), "w");
  git(join(work, ".."), "clone", "-q", p.bareOf("owner/intents"), work);
  execFileSync("git", ["-C", work, "rm", "-rq", "intents"]);
  execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "lose it"]);
  git(work, "push", "-q", "origin", "HEAD:main");
  rmSync(work, { recursive: true, force: true });
  expect((await p.store.list()).open).toEqual([]);
  it.labels = [QUEUED_LABEL];
  await poll();
  const again = proposals(p).filter((x) => x.state === "OPEN");
  expect(again).toHaveLength(1);
  expect(again[0]!.body).toContain("The earlier intent for this issue was lost");
  expect(it.labels).toEqual([PROPOSED_LABEL]);
});

test("issues: a crash does not write the missing intent twice", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored());
  const it = queued(p, "someone");
  // The comment fails after the PR is open.
  p.issueFail = (args) => (args[1] === "comment" ? "HTTP 502" : null);
  await expect(poll()).rejects.toThrow();
  expect(proposals(p)).toHaveLength(1);
  p.issueFail = null;
  await poll();
  expect(proposals(p)).toHaveLength(1);
  expect(p.claudeCalls).toHaveLength(1);
  expect(it.labels).toEqual([PROPOSED_LABEL]);
  expect(it.comments).toHaveLength(1);
});

test("issues: a proposed issue whose PR was closed loses the label and is told", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  proposals(p)[0]!.state = "CLOSED";
  await poll();
  expect(it.labels).toEqual([]);
  expect(it.comments).toHaveLength(2);
  expect(it.comments[1]).toContain("closed without merging");
  expect(proposals(p)).toHaveLength(1);
});

test("issues: a queued issue whose PR was closed loses the label and is told", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  proposals(p)[0]!.state = "CLOSED";
  it.labels = [QUEUED_LABEL];
  await poll();
  expect(it.labels).toEqual([]);
  expect(it.comments[1]).toContain("closed without merging");
  expect(p.claudeCalls).toHaveLength(1);
});

test("issues: a closed-PR comment is written once", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  proposals(p)[0]!.state = "CLOSED";
  // The comment fails first; the label stays, and the retry writes it.
  p.issueFail = (args) => (args[1] === "comment" ? "HTTP 502" : null);
  await expect(poll()).rejects.toThrow();
  expect(it.labels).toEqual([PROPOSED_LABEL]);
  p.issueFail = null;
  await poll();
  await poll();
  await poll();
  expect(it.labels).toEqual([]);
  expect(it.comments.filter((c) => c.includes("closed without merging"))).toHaveLength(1);
});
