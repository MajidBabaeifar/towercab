// Jira tickets become intents (JIRA-4..6): the real store over a local bare repo, a fake Jira over HTTP,
// a fake `gh` for the intent PRs and a fake `claude` that scores.

import { readdirSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";
import { effectiveA } from "../../src/autonomy.ts";
import { fetchHttp } from "../../src/github/app.ts";
import { JiraClient } from "../../src/jira/client.ts";
import { pollJira } from "../../src/jira/poll.ts";
import { Loop } from "../../src/loop.ts";
import { FakeJira } from "../helpers/fake-jira.ts";
import { TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";
import { git } from "../helpers/world.ts";

const SCORE = {
  u: 4,
  u_why: "Accountants hit it every month.",
  i: 3,
  i_why: "One report is affected.",
  title: "Accountants download invoices as a spreadsheet",
  problem: "Invoices cannot be exported.",
  outcome: ["Invoices download as a spreadsheet"],
  affected: "",
  constraints: [],
  open_questions: [],
};
const scored =
  (o: Record<string, unknown> = {}) =>
  () => ({ structured: { ...SCORE, ...o } });

let fake: FakeJira;
beforeEach(async () => {
  fake = await new FakeJira().start();
});
afterEach(() => fake.stop());

async function world() {
  const p = new Pipe(TARGET, {});
  await p.start({}, { handlers: {} });
  const client = new JiraClient(fake.config(fake.table().jql as string), fetchHttp, async () => {});
  const config = p.config({ jira: fake.table() });
  const deps = () => ({
    config,
    home: p.home,
    tools: p.tools,
    clock: p.clock,
    store: p.store,
    github: p.github(),
    log: (l: string) => p.logs.push(l),
    busy: () => new Set<string>(),
    userHome: "/home/me",
    jira: client,
  });
  return { p, config, client, poll: () => pollJira(deps()) };
}

const proposals = (p: Pipe) => p.prs.filter((x) => x.repo === "owner/intents" && x.head.startsWith("jira/"));

/** The owner merges every open intent PR; then the intents on `main`. */
async function accepted(p: Pipe) {
  for (const pr of proposals(p)) if (pr.state === "OPEN") p.mergePr(pr);
  return p.store.list();
}

test("jira: a ticket becomes one intent PR", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  fake.ticket({ key: "ABC-1", description: "Please export them." });
  await poll();
  await poll();
  const [pr, ...more] = proposals(p);
  expect(more).toEqual([]);
  expect(pr).toMatchObject({ head: "jira/web-ABC-1", base: "main", state: "OPEN" });
  // The key starts the PR title; the body links the ticket and says that merging accepts it.
  expect(pr!.title).toMatch(
    /^ABC-1: docs\(intents\): add \S+ Accountants download invoices as a spreadsheet$/,
  );
  expect(pr!.body).toContain(`${fake.site}/browse/ABC-1`);
  expect(pr!.body).toContain("Merging this pull request accepts it as work");
  expect(p.claudeCalls).toHaveLength(1);
  const i = (await accepted(p)).open[0]!;
  expect(i).toMatchObject({ jira: "ABC-1", source: "jira", repo: "web", u: 4, i: 3 });
  expect(i.text).toMatch(/^source: jira\njira: ABC-1\nstarted: /m);
  expect(i.issue).toBeNull();
  // The ticket is not touched: no comment from the poll itself.
  expect(fake.writes()).toEqual([]);
});

test("jira: nothing from a ticket reaches main before the owner merges", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  fake.ticket({ key: "ABC-1" });
  await poll();
  await poll();
  expect((await p.store.list()).open).toEqual([]);
  expect(git(p.bares.intents!, "log", "--format=%s", "main").trim().split("\n")).toEqual(["seed"]);
  expect(proposals(p).map((x) => x.state)).toEqual(["OPEN"]);
  // Towercab never merges it itself, and the PR's branch is the ticket's.
  expect(p.forge.calls.filter((l) => l.startsWith("merge "))).toEqual([]);
  // A ticket the filter does not return is never proposed, nor its text read.
  fake.ticket({ key: "ABC-2", inFilter: false, summary: "SECRET-SUMMARY" });
  await poll();
  expect(proposals(p)).toHaveLength(1);
  expect(p.logs.join("\n")).not.toContain("SECRET");
});

/** Propose the ticket, then end the intent with `stage`. */
async function ended(stage: "done" | "dropped") {
  const w = await world();
  w.p.queue("score", scored());
  fake.ticket({ key: "ABC-1" });
  await w.poll();
  const id = (await accepted(w.p)).open[0]!.id;
  await w.poll();
  await w.p.store.update(id, stage, (e) => e.setField("stage", stage));
  await w.poll();
  return { ...w, id };
}

test("jira: a done intent blocks its ticket", async () => {
  const { p } = await ended("done");
  const l = await p.store.list();
  expect(l.open).toEqual([]);
  expect(l.done).toHaveLength(1);
  expect(p.claudeCalls).toHaveLength(1);
  expect(proposals(p)).toHaveLength(1);
});

test("jira: a closed intent PR is never proposed again", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored());
  fake.ticket({ key: "ABC-1" });
  await poll();
  proposals(p)[0]!.state = "CLOSED";
  await poll();
  await poll();
  expect(p.claudeCalls).toHaveLength(1);
  expect(proposals(p).map((x) => x.state)).toEqual(["CLOSED"]);
  expect((await p.store.list()).open).toEqual([]);
});

test("jira: a crash before the comment does not write twice", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored());
  fake.ticket({ key: "ABC-1" });
  // The branch is pushed, then opening the PR fails: the poll is cut short with one error.
  p.forge.failNext("openPr", 1, "HTTP 502");
  await expect(poll()).rejects.toThrow("ABC-1: HTTP 502");
  expect(proposals(p)).toEqual([]);
  // The next poll finds nothing opened and proposes once; later ones find the PR by its branch.
  await poll();
  await poll();
  expect(proposals(p)).toHaveLength(1);
  expect(git(p.bares.intents!, "branch", "--list", "jira/*").trim()).toBe("jira/web-ABC-1");
  // Merged: one intent, never a second proposal.
  const l = await accepted(p);
  expect(l.open).toHaveLength(1);
  await poll();
  expect(proposals(p)).toHaveLength(1);
  expect((await p.store.list()).open).toHaveLength(1);
  expect(fake.writes()).toEqual([]);
});

test("jira: the scoring run gets no tools", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  fake.ticket({
    key: "ABC-1",
    summary: "Export invoices",
    labels: ["finance"],
    description: "Totals per currency.",
  });
  await poll();
  const c = p.claudeCalls[0]!;
  expect(c.kind).toBe("score");
  expect(c.argv[c.argv.indexOf("--tools") + 1]).toBe("");
  expect(c.argv).not.toContain("--allowedTools");
  expect(c.argv).toContain("--json-schema");
  expect(c.prompt).toContain("Title: Export invoices");
  expect(c.prompt).toContain("Labels: finance");
  expect(c.prompt).toContain("Totals per currency.");
  // Only the ticket's own words: no comment of anyone else, no other ticket.
  expect(readdirSync(c.cwd)).toEqual([]);
  expect(c.settings).toMatchObject({ sandbox: { enabled: true } });
});

test("jira: a description becomes plain text", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  fake.ticket({
    key: "ABC-1",
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Finance needs a CSV." }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "per currency" }] }],
            },
          ],
        },
      ],
    },
  });
  await poll();
  const prompt = p.claudeCalls[0]!.prompt;
  expect(prompt).toContain("Finance needs a CSV.\n- per currency");
  expect(prompt).not.toContain('"type"');
});

test("jira: an empty description scores from the summary", async () => {
  const { p, poll } = await world();
  p.queue("score", scored(), scored());
  fake.ticket({ key: "ABC-1", summary: "Export invoices", description: null });
  fake.ticket({
    key: "ABC-2",
    summary: "Export refunds",
    description: { type: "doc", version: 1, content: [] },
  });
  await poll();
  expect(p.claudeCalls).toHaveLength(2);
  expect(p.claudeCalls[0]!.prompt).toContain("Title: Export invoices");
  expect(p.claudeCalls[1]!.prompt).toContain("Title: Export refunds");
  expect(proposals(p)).toHaveLength(2);
});

test("jira: two bad results ask the owner to write it by hand", async () => {
  const { p, poll } = await world();
  p.queue("score", scored({ u: 9 }), scored({ title: "" }));
  fake.ticket({ key: "ABC-1" });
  await poll();
  expect(proposals(p)).toEqual([]);
  expect(fake.posted("ABC-1")).toHaveLength(1);
  expect(fake.posted("ABC-1")[0]).toContain("write the intent by hand");
  // The ticket is not read again, nor scored again, nor commented again.
  await poll();
  expect(p.claudeCalls).toHaveLength(2);
  expect(fake.posted("ABC-1")).toHaveLength(1);
});

test("jira: a3 by default", async () => {
  const { p, poll } = await world();
  p.queue("score", scored());
  // A label on the ticket changes nothing: there is no label to raise it.
  fake.ticket({ key: "ABC-1", labels: ["a5"] });
  await poll();
  const i = (await accepted(p)).open[0]!;
  expect(i.a).toBe(3);
  expect(effectiveA(5, 5, i.source)).toBe(4);
});

test("jira: the poll runs every 5 minutes", async () => {
  const p = new Pipe(TARGET, {});
  await p.start({}, { handlers: {} });
  const client = new JiraClient(fake.config(), fetchHttp, async () => {});
  const loop = new Loop(
    {
      config: p.config({ jira: fake.table() }),
      home: p.home,
      db: p.db,
      tools: p.tools,
      clock: p.clock,
      store: p.store,
      github: p.github(),
      jira: client,
      handlers: {},
      log: (l) => p.logs.push(l),
      sender: null,
    },
    { watch: true },
  );
  await loop.open();
  const searches = () => fake.seen.filter((s) => s.path === "/rest/api/3/search/jql").length;
  const pass = async (advance: number) => {
    p.clock.advance(advance);
    await loop.pass();
    await loop.jiraIdle();
  };
  await pass(0);
  expect(searches()).toBe(1);
  await pass(60);
  expect(searches()).toBe(1);
  await pass(238);
  expect(searches()).toBe(1);
  await pass(3);
  expect(searches()).toBe(2);
  p.cleanup();
});

test("jira: a Jira failure is a Jira fault", async () => {
  const p = new Pipe(TARGET, {});
  await p.start({}, { handlers: {} });
  const client = new JiraClient(fake.config(), fetchHttp, async () => {});
  const loop = new Loop(
    {
      config: p.config({ jira: fake.table() }),
      home: p.home,
      db: p.db,
      tools: p.tools,
      clock: p.clock,
      store: p.store,
      github: p.github(),
      jira: client,
      handlers: {},
      log: (l) => p.logs.push(l),
      sender: null,
    },
    { watch: true },
  );
  await loop.open();
  fake.failNext = { status: 503, times: 9 };
  await loop.pass();
  await loop.jiraIdle();
  expect(loop.health.open().map((f) => f.kind)).toEqual(["jira"]);
  expect(p.logs.join("\n")).toContain("reading Jira failed: Jira GET /rest/api/3/search/jql: HTTP 503");
  // A Jira outage never holds the loop's work back, however long it lasts.
  p.clock.advance(3600);
  expect(loop.health.blocked(p.clock.now())).toBe(false);
  // The next poll that works closes the fault.
  fake.failNext = null;
  p.clock.advance(301);
  await loop.pass();
  await loop.jiraIdle();
  expect(loop.health.open()).toEqual([]);
  p.cleanup();
});
