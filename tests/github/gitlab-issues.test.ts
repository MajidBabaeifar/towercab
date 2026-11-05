// GitLab issues become intents (INT-63..68): the same poll as GitHub's, over a fake GitLab, with the intents
// repo still on GitHub (a fake `gh` serves the intent PRs) and a fake `claude` that scores the issues.

import { readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { effectiveA } from "../../src/autonomy.ts";
import { Db } from "../../src/db.ts";
import { GitLabForge } from "../../src/forge/gitlab.ts";
import { type IssueDeps, pollIssues } from "../../src/github/issues.ts";
import { Loop } from "../../src/loop.ts";
import { intent, TARGET } from "../helpers/flows.ts";
import { gitlabConfig } from "../helpers/gitlab.ts";
import { FakeGitLabIssues } from "../helpers/gitlab-issues.ts";
import { Pipe } from "../helpers/pipe.ts";

const PROJECT = "g/proj";
const URL1 = `https://gitlab.test/${PROJECT}/-/issues/1`;

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

/** A repo table for a GitLab project. */
const glRepo = (name: string, path: string) => ({
  name,
  github: `gitlab:${path}`,
  path: "",
  base: "main",
  workers: 1,
  ahead: 3,
  env: {},
});

async function world(
  files: Record<string, string> = {},
  busy: string[] = [],
  projects = [["proj", PROJECT]],
) {
  const p = new Pipe(TARGET, files);
  await p.start({}, { handlers: {} });
  await p.loop.issuesIdle();
  const fake = new FakeGitLabIssues();
  const gitlab = new GitLabForge(gitlabConfig().cfg, fake.http);
  const config = p.config();
  // The loop reloads its repos from the file's tables and its database, so both hold the GitLab ones.
  for (const repos of [config.repos, config.fileRepos]) {
    repos.delete("web");
    for (const [name, path] of projects) repos.set(name!, glRepo(name!, path!));
  }
  const deps = (): IssueDeps => ({
    config,
    home: p.home,
    tools: p.tools,
    clock: p.clock,
    store: p.store,
    github: p.github(),
    gitlab,
    log: (l) => p.logs.push(l),
    busy: () => new Set(busy),
    userHome: "/home/me",
  });
  return { p, fake, gitlab, config, poll: () => pollIssues(deps()) };
}

const intents = (p: Pipe) => p.store.list();

/** The intent PRs Towercab opened from issues (on GitHub: the intents repo is there). */
const proposals = (p: Pipe) => p.prs.filter((x) => x.repo === "owner/intents" && x.head.startsWith("issue/"));

/** The owner merges every open intent PR; then the intents on `main`. */
function accepted(p: Pipe) {
  for (const pr of proposals(p)) if (pr.state === "OPEN") p.mergePr(pr);
  return intents(p);
}

test("gitlab issues: the owner's issue is eligible", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  fake.issue(PROJECT, { author: "owner" });
  await poll();
  const l = await accepted(p);
  expect(l.open.map((i) => i.title)).toEqual(["Show a greeting"]);
});

test("gitlab issues: a towercab label makes another author's issue eligible", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  fake.issue(PROJECT, { author: "stranger", labels: ["towercab"] });
  await poll();
  expect((await accepted(p)).open).toHaveLength(1);
});

test("gitlab issues: an unlabelled issue by someone else is never read", async () => {
  const { p, fake, poll } = await world();
  fake.issue(PROJECT, {
    author: "stranger",
    title: "SECRET-TITLE",
    description: "SECRET-BODY",
    labels: ["bug"],
  });
  await poll();
  expect((await intents(p)).open).toHaveLength(0);
  expect(proposals(p)).toEqual([]);
  expect(p.claudeCalls).toEqual([]);
  expect(fake.reads()).toEqual([]);
  expect(fake.issues.get(PROJECT)![0]!.notes).toEqual([]);
  expect(p.logs.join("\n")).not.toContain("SECRET");
});

test("gitlab issues: a confidential issue is never read", async () => {
  const { p, fake, poll } = await world();
  // The owner's own, a labelled one, and one whose answer does not say: none is read.
  fake.issue(PROJECT, { title: "SECRET-TITLE", confidential: true });
  fake.issue(PROJECT, { author: "stranger", labels: ["towercab"], confidential: true });
  fake.issue(PROJECT, { confidential: undefined });
  await poll();
  expect((await accepted(p)).open).toHaveLength(0);
  expect(proposals(p)).toEqual([]);
  expect(p.claudeCalls).toEqual([]);
  expect(fake.reads()).toEqual([]);
  for (const i of fake.issues.get(PROJECT)!) {
    expect(i.notes).toEqual([]);
    expect(i.labelEvents).toEqual([]);
  }
  expect(p.logs.join("\n")).not.toContain("SECRET");
});

test("gitlab issues: the scoring run gets no tools", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  fake.issue(PROJECT, { title: "Greeting is missing", description: "Nothing shows.", labels: ["bug"] });
  await poll();
  const c = p.claudeCalls[0]!;
  expect(c.kind).toBe("score");
  expect(c.argv[c.argv.indexOf("--tools") + 1]).toBe("");
  expect(c.argv).not.toContain("--allowedTools");
  expect(c.prompt).toContain("Title: Greeting is missing");
  expect(c.prompt).toContain("Labels: bug");
  expect(c.prompt).toContain("Nothing shows.");
  expect(readdirSync(c.cwd)).toEqual([]);
});

test("gitlab issues: an issue becomes one intent PR", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  fake.issue(PROJECT, { labels: ["bug"] });
  await poll();
  await poll();
  const [pr, ...more] = proposals(p);
  expect(more).toEqual([]);
  // The proposal is a pull request on the GitHub intents repo, not a GitLab merge request.
  expect(pr).toMatchObject({ repo: "owner/intents", head: "issue/proj-1", base: "main", state: "OPEN" });
  expect(pr!.body).toContain(URL1);
  expect(fake.calls.filter((c) => c.includes("merge_requests"))).toEqual([]);
  const i = (await accepted(p)).open[0]!;
  expect(i).toMatchObject({ repo: "proj", u: 4, i: 3, a: 3, source: "issue", issue: URL1 });
  expect(p.claudeCalls).toHaveLength(1);
});

test("gitlab issues: a labelled issue with no intent is proposed once", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored(), scored());
  const it = fake.issue(PROJECT, {
    labels: ["towercab:queued"],
    labelEvents: [{ label: "towercab:queued", user: "stranger" }],
  });
  await poll();
  await poll();
  expect(proposals(p).map((x) => x.state)).toEqual(["OPEN"]);
  expect(p.claudeCalls).toHaveLength(1);
  expect(it.labels).toEqual(["towercab:proposed"]);
  expect(it.notes).toHaveLength(1);
});

test("gitlab issues: an a-label sets the autonomy", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored(), scored());
  fake.issue(PROJECT, { labels: ["a4"] });
  fake.issue(PROJECT, { labels: ["a4", "a2"] });
  await poll();
  const open = (await accepted(p)).open;
  expect(open.map((i) => [i.issue, i.a]).sort()).toEqual([
    [`https://gitlab.test/${PROJECT}/-/issues/1`, 4],
    [`https://gitlab.test/${PROJECT}/-/issues/2`, 2],
  ]);
  // a5 is still capped at a4 for an issue (AUT-13).
  expect(effectiveA(5, 5, 5, "issue")).toBe(4);
});

test("gitlab issues: missing labels are created in the project", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  const it = fake.issue(PROJECT);
  await poll();
  expect(fake.labels.get(PROJECT)).toEqual(new Set(["towercab:proposed"]));
  expect(it.labels).toEqual(["towercab:proposed"]);
  await accepted(p);
  await poll();
  expect(fake.labels.get(PROJECT)).toEqual(new Set(["towercab:proposed", "towercab:queued"]));
  expect(it.labels).toContain("towercab:queued");
});

test("gitlab issues: an existing label is left alone", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  fake.labels.set(PROJECT, new Set(["towercab:proposed"]));
  const it = fake.issue(PROJECT);
  await poll();
  expect(it.labels).toEqual(["towercab:proposed"]);
  // The label was asked for once and found; nothing edited or deleted it.
  expect(fake.calls.filter((c) => c.includes("/labels"))).toEqual([`POST /projects/g%2Fproj/labels`]);
  expect(fake.labels.get(PROJECT)).toEqual(new Set(["towercab:proposed"]));
});

test("gitlab issues: the queued note names scores and place", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  const it = fake.issue(PROJECT);
  await poll();
  const i = (await accepted(p)).open[0]!;
  await poll();
  const c = it.notes[1]!;
  expect(c).toContain(p.store.url(i)!);
  expect(c).toContain("Urgency 4 of 5: Visitors hit it on every page.");
  expect(c).toContain("Importance 3 of 5: One page is affected.");
  expect(c).toContain("It is number 1 in the queue.");
  expect(it.labels).toContain("towercab:queued");
});

test("gitlab issues: an issue is noted once", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  const it = fake.issue(PROJECT);
  await poll();
  await poll();
  expect(it.notes).toHaveLength(1);
  expect(it.notes[0]).toContain("Nothing starts until the owner merges it.");
  await accepted(p);
  await poll();
  await poll();
  expect(it.notes).toHaveLength(2);
  expect(p.claudeCalls).toHaveLength(1);
  expect((await intents(p)).open).toHaveLength(1);
});

test("gitlab issues: a done intent blocks its issue", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  const it = fake.issue(PROJECT);
  await poll();
  const id = (await accepted(p)).open[0]!.id;
  await poll();
  await p.store.update(id, "done", (e) => e.setField("stage", "done"));
  it.labels = [];
  await poll();
  const l = await intents(p);
  expect(l.open).toEqual([]);
  expect(l.done.map((i) => i.id)).toEqual([id]);
  expect(p.claudeCalls).toHaveLength(1);
  expect(it.notes).toHaveLength(2);
  expect(proposals(p)).toHaveLength(1);
});

test("gitlab issues: closing the issue drops an unstarted intent", async () => {
  const { p, fake, poll } = await world();
  p.queue("score", scored());
  const it = fake.issue(PROJECT);
  await poll();
  await accepted(p);
  it.state = "closed";
  await poll();
  const l = await intents(p);
  expect(l.open).toEqual([]);
  expect(l.done[0]).toMatchObject({ stage: "dropped", dir: expect.stringMatching(/^done\//) });
  expect(l.done[0]!.sections.get("Towercab")).toBe("issue closed");
});

test("gitlab issues: a started intent ignores a closed issue", async () => {
  const busy: string[] = [];
  const { p, fake, poll } = await world({}, busy);
  p.queue("score", scored(), scored());
  const a = fake.issue(PROJECT);
  const b = fake.issue(PROJECT);
  await poll();
  const [first, second] = (await accepted(p)).open.map((i) => i.id);
  await p.store.update(first!, "stage", (e) => e.setField("stage", "code"));
  busy.push(second!);
  a.state = "closed";
  b.state = "closed";
  await poll();
  const l = await intents(p);
  expect(l.open.map((i) => i.id).sort()).toEqual([first, second].sort());
});

test("gitlab issues: one failing repo does not stop the others", async () => {
  const { p, fake, poll } = await world(
    {},
    [],
    [
      ["proj", PROJECT],
      ["other", "g/other"],
    ],
  );
  p.queue("score", scored());
  fake.listFails = (project) => (project === PROJECT ? "bad gateway" : null);
  fake.issue("g/other");
  await expect(poll()).rejects.toThrow(/gitlab:g\/proj.*HTTP 502/);
  expect(proposals(p).map((x) => x.head)).toEqual(["issue/other-1"]);
});

/** A loop over the same store with GitLab, on its own database. */
async function gitlabLoop(w: Awaited<ReturnType<typeof world>>) {
  const loop = new Loop(
    {
      config: w.config,
      home: w.p.home,
      db: Db.memory(),
      tools: w.p.tools,
      clock: w.p.clock,
      store: w.p.store,
      github: w.p.github(),
      gitlab: w.gitlab,
      handlers: {},
      log: (l) => w.p.logs.push(l),
      sender: null,
    },
    { watch: true },
  );
  await loop.open();
  await loop.issuesIdle();
  return loop;
}

const lists = (w: Awaited<ReturnType<typeof world>>) =>
  w.fake.calls.filter((c) => c === "GET /projects/g%2Fproj/issues").length;

test("gitlab issues: the poll runs every 5 minutes", async () => {
  const w = await world();
  const loop = await gitlabLoop(w);
  // On start.
  expect(lists(w)).toBe(1);
  for (const [seconds, calls] of [
    [0, 1],
    [299, 1],
    [1, 2],
    [299, 2],
    [1, 3],
  ] as const) {
    w.p.clock.advance(seconds);
    await loop.pass();
    await loop.issuesIdle();
    expect(lists(w)).toBe(calls);
  }
});

test("gitlab issues: a GitLab failure is a fault", async () => {
  const w = await world();
  w.fake.listFails = () => "bad gateway";
  const loop = await gitlabLoop(w);
  const fault = loop.health.open().find((f) => f.kind === "github");
  expect(fault?.error).toContain("gitlab:g/proj");
  expect(fault?.error).toContain("HTTP 502");
  // Retried on the next due poll, and cleared once GitLab answers.
  w.fake.listFails = null;
  w.p.clock.advance(301);
  await loop.pass();
  await loop.issuesIdle();
  expect(loop.health.open().map((f) => f.kind)).not.toContain("github");
});

test("gitlab issues: an intent from an old issue keeps its place", async () => {
  const w = await world({ "intents/261026-1000-old/intent.md": intent({ title: "Old", u: 5, i: 5 }) });
  w.p.queue("score", scored());
  const it = w.fake.issue(PROJECT);
  await w.poll();
  await accepted(w.p);
  await w.poll();
  expect(it.notes[1]).toContain("It is number 2 in the queue.");
});
