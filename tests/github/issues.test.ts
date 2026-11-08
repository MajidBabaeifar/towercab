// GitHub issues become intents (INT-20..28): the real store over a local bare repo, a fake `gh` that
// serves issues and the intent PRs, and a fake `claude` that scores them. Only a merged PR is an intent.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { effectiveA } from "../../src/autonomy.ts";
import { type IssueDeps, pollIssues } from "../../src/github/issues.ts";
import { intent, TARGET } from "../helpers/flows.ts";
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

async function world(files: Record<string, string> = {}, busy: string[] = []) {
  const p = new Pipe(TARGET, files);
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
    busy: () => new Set(busy),
    userHome: "/home/me",
  });
  return { p, poll: () => pollIssues(deps()) };
}

const intents = (p: Pipe) => p.store.list();

/** The intent PRs Towercab opened from issues. */
const proposals = (p: Pipe) => p.prs.filter((x) => x.repo === "owner/intents" && x.head.startsWith("issue/"));

/** The owner merges every open intent PR; then the intents on `main`. */
function accepted(p: Pipe) {
  for (const pr of proposals(p)) if (pr.state === "OPEN") p.mergePr(pr);
  return intents(p);
}

test("issues: the owner's issue is eligible", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  p.issue({ author: "Owner" });
  await poll();
  const l = await accepted(p);
  expect(l.open.map((i) => i.title)).toEqual(["Show a greeting"]);
});

test("issues: a towercab label makes another author's issue eligible", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  p.issue({ author: "stranger", labels: ["towercab"] });
  await poll();
  expect((await accepted(p)).open).toHaveLength(1);
});

test("issues: an unlabelled issue by someone else is never read", async () => {
  const { p, poll } = await world();
  p.issue({ author: "stranger", title: "SECRET-TITLE", body: "SECRET-BODY", labels: ["bug"] });
  await poll();
  expect((await intents(p)).open).toHaveLength(0);
  expect(proposals(p)).toEqual([]);
  expect(p.claudeCalls).toEqual([]);
  expect(p.forge.calls.filter((c) => c.startsWith("read-issue"))).toEqual([]);
  expect(p.logs.join("\n")).not.toContain("SECRET");
});

test("issues: the scoring run gets no tools", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  p.issue({ title: "Greeting is missing", body: "Nothing shows.", labels: ["bug"] });
  await poll();
  const c = p.claudeCalls[0]!;
  expect(c.kind).toBe("score");
  expect(c.argv[c.argv.indexOf("--tools") + 1]).toBe("");
  expect(c.argv).not.toContain("--allowedTools");
  expect(c.argv).toContain("--disallowedTools");
  expect(c.argv).toContain("--json-schema");
  expect(c.prompt).toContain("Title: Greeting is missing");
  expect(c.prompt).toContain("Labels: bug");
  expect(c.prompt).toContain("Nothing shows.");
  // No repo access: it runs in an empty folder.
  expect(readdirSync(c.cwd)).toEqual([]);
  expect(c.settings).toMatchObject({ sandbox: { enabled: true } });
});

test("issues: the scorer names the work as a user story about the product", async () => {
  const { p, poll } = await world();
  p.queue("score", scored({ title: "Web greets every visitor when the page opens" }));
  p.issue({ title: "Greeting is missing", body: "Nothing shows.", labels: ["bug"] });
  await poll();
  // INT-35: the prompt gives the product (the repo's name) and the naming rule; its title is the intent's.
  const c = p.claudeCalls[0]!;
  expect(c.prompt).toContain("the work's title as a user story");
  expect(c.prompt).toMatch(/Name the\s+product \(web\)/);
  expect(c.prompt).toMatch(/No file names,\s+functions, flags or jargon/);
  expect((await accepted(p)).open.map((i) => i.title)).toEqual([
    "Web greets every visitor when the page opens",
  ]);
});

test("issues: the scoring prompt forbids fence markers in prose", () => {
  const prompt = readFileSync(join(import.meta.dirname, "../../agents/score.md"), "utf8");
  expect(prompt).toContain(
    "Never start a line of `problem` or `outcome` with three backticks or three tildes",
  );
});

test("issues: the intent keeps affected, constraints and open questions", async () => {
  const { p, poll } = await world();
  p.queue(
    "score",
    scored({
      affected: "Visitors of the home page.",
      constraints: ["No new dependency", "## Keep the old URL"],
      open_questions: ["Should the greeting be translated?"],
    }),
  );
  p.issue();
  await poll();
  const i = (await accepted(p)).open[0]!;
  expect([...i.sections.keys()]).toEqual([
    "Problem",
    "Proposed outcome",
    "Affected users and systems",
    "Constraints",
    "Open questions",
    "Towercab",
  ]);
  expect(i.sections.get("Affected users and systems")).toBe("Visitors of the home page.");
  // Model text cannot open a section or a list of its own.
  expect(i.sections.get("Constraints")).toBe("- No new dependency\n- Keep the old URL");
  expect(i.sections.get("Open questions")).toBe("- Should the greeting be translated?");
  const prompt = readFileSync(join(import.meta.dirname, "../../agents/score.md"), "utf8");
  expect(prompt).toContain("never invent");
});

test("issues: empty sections are left out", async () => {
  const { p, poll } = await world();
  p.queue("score", scored({ affected: "  ", constraints: ["", " "], open_questions: [] }));
  p.issue();
  await poll();
  const i = (await accepted(p)).open[0]!;
  expect([...i.sections.keys()]).toEqual(["Problem", "Proposed outcome", "Towercab"]);
});

test("issues: a bad score result is retried once", async () => {
  const { p, poll } = await world();
  p.queue("score", scored({ u: 9 }), scored());
  p.issue();
  await poll();
  expect(p.claudeCalls).toHaveLength(2);
  expect((await accepted(p)).open).toHaveLength(1);
});

test("issues: two bad results ask the owner to write it by hand", async () => {
  const { p, poll } = await world();
  p.queue("score", scored({ u: 9 }), scored({ title: "" }));
  const it = p.issue();
  await poll();
  expect((await intents(p)).open).toHaveLength(0);
  expect(proposals(p)).toEqual([]);
  expect(it.comments).toHaveLength(1);
  expect(it.comments[0]).toContain("write the intent by hand");
  expect(it.labels).toContain("towercab:failed");
  // Not scored again until the owner removes the label.
  await poll();
  expect(p.claudeCalls).toHaveLength(2);
  expect(it.comments).toHaveLength(1);
});

test("issues: an issue becomes one intent PR", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  p.issue({ labels: ["bug"] });
  await poll();
  const [pr, ...more] = proposals(p);
  expect(more).toEqual([]);
  expect(pr).toMatchObject({
    head: "issue/web-1",
    base: "main",
    state: "OPEN",
    author: "towercab[bot]",
    title: expect.stringMatching(/^docs\(intents\): add \d{6}-\d{4} Show a greeting$/),
  });
  expect(pr!.body).toContain("https://github.com/owner/web/issues/1");
  expect(pr!.body).toContain("Urgency 4 of 5: Visitors hit it on every page.");
  expect(pr!.body).toContain("Merging this pull request accepts it");
  const i = (await accepted(p)).open[0]!;
  expect(pr!.title).toBe(`docs(intents): add ${i.id} Show a greeting`);
  expect(i).toMatchObject({
    repo: "web",
    u: 4,
    i: 3,
    a: 3,
    source: "issue",
    issue: "https://github.com/owner/web/issues/1",
    title: "Show a greeting",
  });
  expect(i.sections.get("Problem")).toBe("The page greets nobody.");
  expect(i.sections.get("Proposed outcome")).toBe("- The page says hello");
  expect(i.sections.get("Towercab")).toContain("Urgency 4 of 5: Visitors hit it on every page.");
});

test("issues: nothing from an issue reaches main before the owner merges", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  await poll();
  await poll();
  expect((await intents(p)).open).toEqual([]);
  expect(git(p.bares.intents!, "log", "--format=%s", "main").trim().split("\n")).toEqual(["seed"]);
  expect(proposals(p).map((x) => x.state)).toEqual(["OPEN"]);
  expect(p.claudeCalls).toHaveLength(1);
  expect(it.labels).toEqual(["towercab:proposed"]);
  // Towercab never merges it itself.
  expect(p.forge.calls.filter((l) => l.startsWith("merge "))).toEqual([]);
});

test("issues: proposals in the same minute get different IDs", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored({ title: "Show a farewell" }), scored({ title: "Show a date" }));
  p.issue();
  p.issue();
  await poll();
  // A later poll in the same minute steers clear of the open PRs' IDs too.
  p.issue();
  await poll();
  const ids = proposals(p).map((x) => /add (\S+) /.exec(x.title)![1]);
  expect(new Set(ids).size).toBe(3);
  const l = await accepted(p);
  expect(l.unreadable).toEqual([]);
  expect(l.open.map((i) => i.id).sort()).toEqual([...ids].sort());
});

test("issues: a crash before the comment does not write twice", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  p.forge.failNext("commentOnIssue", 99, "HTTP 502");
  await expect(poll()).rejects.toThrow("HTTP 502");
  expect(proposals(p)).toHaveLength(1);
  expect(it.comments).toEqual([]);
  p.forge.failNext("commentOnIssue", 0);
  await poll();
  expect(proposals(p)).toHaveLength(1);
  expect(p.claudeCalls).toHaveLength(1);
  expect(it.comments).toHaveLength(1);
  expect(it.labels).toContain("towercab:proposed");
  // And once merged, the queued comment fails and is retried without a second intent.
  await accepted(p);
  p.forge.failNext("commentOnIssue", 99, "HTTP 502");
  await expect(poll()).rejects.toThrow("HTTP 502");
  p.forge.failNext("commentOnIssue", 0);
  await poll();
  expect((await intents(p)).open).toHaveLength(1);
  expect(it.comments).toHaveLength(2);
  expect(it.labels).toContain("towercab:queued");
});

test("issues: a3 by default", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  p.issue({ labels: ["bug", "a-team"] });
  await poll();
  expect((await accepted(p)).open[0]!.a).toBe(3);
});

test("issues: an a-label sets the autonomy", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored());
  p.issue({ labels: ["a4"] });
  p.issue({ labels: ["a4", "a2"] });
  await poll();
  const open = (await accepted(p)).open;
  expect(open.map((i) => [i.issue, i.a]).sort()).toEqual([
    ["https://github.com/owner/web/issues/1", 4],
    ["https://github.com/owner/web/issues/2", 2],
  ]);
});

test("issues: a5 label stays at a4", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  p.issue({ labels: ["a5"] });
  await poll();
  const i = (await accepted(p)).open[0]!;
  expect(i.a).toBe(5);
  expect(effectiveA(i.a, 5, i.source)).toBe(4);
});

test("issues: the proposed comment links the PR", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  const pr = proposals(p)[0]!;
  expect(it.comments).toHaveLength(1);
  expect(it.comments[0]).toContain(`https://github.com/owner/intents/pull/${pr.number}`);
  expect(it.comments[0]).toContain("Nothing starts until the owner merges it.");
  expect(it.labels).toEqual(["towercab:proposed"]);
});

test("issues: the queued comment names scores and place", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  const i = (await accepted(p)).open[0]!;
  await poll();
  const c = it.comments[1]!;
  expect(c).toContain(p.store.url(i)!);
  expect(c).toContain("Urgency 4 of 5: Visitors hit it on every page.");
  expect(c).toContain("Importance 3 of 5: One page is affected.");
  expect(c).toContain("It is number 1 in the queue.");
  expect(it.labels).toContain("towercab:queued");
});

test("issues: an issue is commented once", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  await poll();
  expect(it.comments).toHaveLength(1);
  await accepted(p);
  await poll();
  await poll();
  expect(it.comments).toHaveLength(2);
  expect(p.claudeCalls).toHaveLength(1);
  expect((await intents(p)).open).toHaveLength(1);
});

/** Queue the issue, then end the intent with `stage`; the owner then removes the label. */
async function ended(stage: "done" | "dropped") {
  const w = await world();
  w.p.queue("score", scored());
  const it = w.p.issue();
  await w.poll();
  const id = (await accepted(w.p)).open[0]!.id;
  await w.poll();
  await w.p.store.update(id, stage, (e) => e.setField("stage", stage));
  it.labels = [];
  await w.poll();
  return { ...w, it, id };
}

test("issues: a done intent blocks its issue", async () => {
  const { p, it, id } = await ended("done");
  const l = await intents(p);
  expect(l.open).toEqual([]);
  expect(l.done.map((i) => i.id)).toEqual([id]);
  expect(p.claudeCalls).toHaveLength(1);
  expect(it.comments).toHaveLength(2);
  expect(proposals(p)).toHaveLength(1);
});

test("issues: a dropped intent blocks its issue", async () => {
  const { p, it, id } = await ended("dropped");
  const l = await intents(p);
  expect(l.open).toEqual([]);
  expect(l.done.map((i) => i.id)).toEqual([id]);
  expect(p.claudeCalls).toHaveLength(1);
  expect(it.comments).toHaveLength(2);
  expect(proposals(p)).toHaveLength(1);
});

test("issues: a closed intent PR is never proposed again", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored());
  const it = p.issue();
  await poll();
  // The owner says no, then even removes the label.
  proposals(p)[0]!.state = "CLOSED";
  it.labels = [];
  await poll();
  await poll();
  expect(p.claudeCalls).toHaveLength(1);
  expect(proposals(p).map((x) => x.state)).toEqual(["CLOSED"]);
  expect((await intents(p)).open).toEqual([]);
});

test("issues: closing the issue closes its open intent PR", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  it.state = "CLOSED";
  await poll();
  const pr = proposals(p)[0]!;
  expect(pr.state).toBe("CLOSED");
  expect(pr.comments.map((c) => c.body)).toEqual(["The issue was closed."]);
  expect((await intents(p)).open).toEqual([]);
});

test("issues: closing the issue drops an unstarted intent", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  await accepted(p);
  it.state = "CLOSED";
  await poll();
  const l = await intents(p);
  expect(l.open).toEqual([]);
  expect(l.done[0]).toMatchObject({ stage: "dropped", dir: expect.stringMatching(/^done\//) });
  expect(l.done[0]!.sections.get("Towercab")).toBe("issue closed");
});

test("issues: a started intent ignores a closed issue", async () => {
  const busy: string[] = [];
  const { p, poll } = await world({}, busy);
  p.queue("score", scored(), scored());
  const a = p.issue();
  const b = p.issue();
  await poll();
  const [first, second] = (await accepted(p)).open.map((i) => i.id);
  // One has a stage, the other a mission that has not written its stage yet.
  await p.store.update(first!, "stage", (e) => e.setField("stage", "code"));
  busy.push(second!);
  a.state = "CLOSED";
  b.state = "CLOSED";
  await poll();
  const l = await intents(p);
  expect(l.open.map((i) => i.id).sort()).toEqual([first, second].sort());
});

test("issues: an intent from an issue starts at its place in the pick order", async () => {
  const { p, poll } = await world({
    "intents/261026-1000-old/intent.md": intent({ title: "Old", u: 5, i: 5 }),
  });
  p.queue("score", scored());
  const it = p.issue();
  await poll();
  await accepted(p);
  await poll();
  expect(it.comments[1]).toContain("It is number 2 in the queue.");
});
