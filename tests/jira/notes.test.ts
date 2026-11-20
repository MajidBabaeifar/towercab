// What a ticket is told (JIRA-7, JIRA-8): queued, started, each PR, done, stopped without merging.

import { afterEach, beforeEach, expect, test } from "vitest";
import { fetchHttp } from "../../src/github/app.ts";
import { JiraClient } from "../../src/jira/client.ts";
import { syncJira } from "../../src/jira/notes.ts";
import { Loop } from "../../src/loop.ts";
import { insertMission } from "../../src/mission.ts";
import { FakeJira } from "../helpers/fake-jira.ts";
import { ID, intent, intents, SLUG, TARGET } from "../helpers/flows.ts";
import { Pipe } from "../helpers/pipe.ts";

let fake: FakeJira;
beforeEach(async () => {
  fake = await new FakeJira().start();
  fake.ticket({ key: "ABC-1" });
});
afterEach(() => fake.stop());

async function world(extra = "jira: ABC-1\n") {
  const p = new Pipe(TARGET, intents(intent({ extra })));
  await p.start({}, { handlers: {} });
  const client = new JiraClient(fake.config(), fetchHttp, async () => {});
  const config = p.config({ jira: fake.table() });
  const sync = (settled = new Map<string, string>()) =>
    syncJira({ config, db: p.db, store: p.store, jira: client, log: (l) => p.logs.push(l) }, settled);
  /** The newest mission, set to `set`. */
  const mission = (set: Record<string, string | number | null> = {}) => {
    const m = insertMission(p.db, { intent: ID, slug: SLUG, repo: "web", model: "opus", a: 5 }, 1);
    for (const [k, v] of Object.entries(set)) p.db.run(`UPDATE missions SET ${k} = ? WHERE id = ?`, v, m.id);
    return m.id;
  };
  const set = (id: number, o: Record<string, string | number | null>) => {
    for (const [k, v] of Object.entries(o)) p.db.run(`UPDATE missions SET ${k} = ? WHERE id = ?`, v, id);
  };
  return { p, sync, mission, set, client, config };
}

const texts = () => fake.posted("ABC-1");
const WEB = "https://github.com/owner/web/pull/";
const INTENTS = "https://github.com/owner/intents/pull/";

test("jira: the queued comment says only where the work stands", async () => {
  const { sync } = await world();
  await sync();
  expect(texts()).toHaveLength(1);
  expect(texts()[0]).toMatch(/^Towercab has queued this ticket as work\./);
  expect(texts()[0]).toContain(`[towercab:queued:${ID}]`);
});

test("jira: the in-progress and done comments are posted at their step", async () => {
  const { sync, mission, set } = await world();
  await sync();
  const id = mission({ stage: "build" });
  await sync();
  expect(texts().map((t) => t.split("\n")[0])).toEqual([
    expect.stringContaining("queued this ticket"),
    "Work on this ticket has started.",
  ]);
  set(id, { pr: 7, stage: "done", merge_sha: "abc" });
  await sync();
  const last = texts().at(-1)!;
  expect(last).toContain("This work is merged.");
  expect(last).toContain(`${WEB}7`);
  expect(last).toContain(`[towercab:done:${ID}]`);
});

/** Queued and started, so the ticket has been told something. */
async function told() {
  const w = await world();
  const id = w.mission({ stage: "build", spec_pr: 1, plan_pr: 2, pr: 3 });
  await w.sync();
  return { ...w, id };
}

test("jira: a dropped intent gets a stopped, not merged comment", async () => {
  const { p, sync, id, mission } = await told();
  void mission;
  p.db.run("UPDATE missions SET stage = 'stopped', why = 'intent removed' WHERE id = ?", id);
  await p.store.update(ID, "drop", (e) => e.setField("stage", "dropped"));
  await sync();
  const last = texts().at(-1)!;
  expect(last).toMatch(/^Stopped, not merged\.\n\nThe owner dropped this work\./);
});

test("jira: a closed unmerged code PR gets a stopped, not merged comment", async () => {
  const { p, sync, id } = await told();
  p.db.run("UPDATE missions SET stage = 'stopped', why = 'PR closed' WHERE id = ?", id);
  await sync();
  expect(texts().at(-1)).toMatch(
    /^Stopped, not merged\.\n\nThe owner closed the pull request without merging it\./,
  );
});

test("jira: the stopped comment gives a plain reason and the PR links", async () => {
  const { p, sync, id } = await told();
  p.db.run("UPDATE missions SET stage = 'stopped', why = ? WHERE id = ?", "worker said: SECRET-DETAIL", id);
  await sync();
  const last = texts().at(-1)!;
  expect(last).toContain("The work could not be completed.");
  expect(last).not.toContain("SECRET");
  for (const u of [`${WEB}1`, `${INTENTS}2`, `${WEB}3`]) expect(last).toContain(`- ${u}`);
});

test("jira: a ticket never told it was queued gets no stopped comment", async () => {
  const { sync } = await world("jira: ABC-1\nstage: dropped\n");
  await sync();
  expect(texts()).toEqual([]);
  expect(fake.writes()).toEqual([]);
});

test("jira: a merged intent never gets a stopped comment", async () => {
  const { p, sync, id, set } = await told();
  set(id, { stage: "done", merge_sha: "abc" });
  await sync();
  await p.store.update(ID, "drop", (e) => e.setField("stage", "dropped"));
  await sync();
  expect(texts().some((t) => t.startsWith("Stopped"))).toBe(false);
  expect(texts().filter((t) => t.includes("This work is merged."))).toHaveLength(1);
});

test("jira: a comment never shows scores or queue place", async () => {
  const { p, sync, id } = await told();
  p.db.run("UPDATE missions SET stage = 'stopped', why = 'PR closed' WHERE id = ?", id);
  await sync();
  const all = texts().join("\n");
  expect(all).not.toMatch(/urgency|importance|priority|queue\b|number \d|score/i);
  expect(all).not.toContain("Show a greeting");
  expect(all).not.toContain("Visitors see nothing");
  expect(all).not.toMatch(/intents\/.*intent\.md|\/blob\//);
});

test("jira: a ticket is commented once", async () => {
  const { sync, mission } = await world();
  mission({ stage: "build", pr: 4 });
  await sync();
  const n = texts().length;
  // A new process has no memory of what it told: the markers on the ticket decide.
  await sync();
  await sync(new Map());
  expect(texts()).toHaveLength(n);
  expect(new Set(texts()).size).toBe(n);
});

test("jira: a failed comment is retried once", async () => {
  const { sync } = await world();
  fake.failComments = 1;
  await expect(sync()).rejects.toThrow("ABC-1: Jira POST /rest/api/3/issue/ABC-1/comment: HTTP 500");
  expect(texts()).toEqual([]);
  await sync();
  await sync();
  expect(texts()).toHaveLength(1);
});

test("jira: each PR is linked on the ticket", async () => {
  const { sync, mission } = await world();
  mission({ stage: "build", spec_pr: 1, plan_pr: 2, pr: 3 });
  await sync();
  const links = texts().filter((t) => t.startsWith("Towercab opened a pull request"));
  expect(links.map((t) => /: (\S+)/.exec(t.split("\n")[0]!)![1])).toEqual([
    `${WEB}1`,
    `${INTENTS}2`,
    `${WEB}3`,
  ]);
  expect(links.map((t) => t.split(" for the ")[1]!.split(":")[0])).toEqual(["requirements", "plan", "code"]);
});

test("jira: a PR is linked once", async () => {
  const { sync, mission } = await world();
  mission({ stage: "stopped", why: "replaced by attempt 2", pr: 3 });
  mission({ stage: "build", pr: 3 });
  await sync();
  await sync();
  expect(texts().filter((t) => t.includes(`${WEB}3`))).toHaveLength(1);
});

test("jira: a failed link does not stop the mission", async () => {
  const p = new Pipe(TARGET, intents(intent({ extra: "jira: ABC-1\n" })));
  await p.start({}, { handlers: {} });
  const m = insertMission(p.db, { intent: ID, slug: SLUG, repo: "web", model: "opus", a: 5 }, 1);
  p.db.run("UPDATE missions SET stage = 'build', pr = 3 WHERE id = ?", m.id);
  const loop = new Loop(
    {
      config: p.config({ jira: fake.table() }),
      home: p.home,
      db: p.db,
      tools: p.tools,
      clock: p.clock,
      store: p.store,
      github: p.github(),
      jira: new JiraClient(fake.config(), fetchHttp, async () => {}),
      handlers: {},
      log: (l) => p.logs.push(l),
      sender: null,
    },
    { watch: true },
  );
  await loop.open();
  fake.failComments = 99;
  await loop.pass();
  await loop.jiraIdle();
  // The pass went on, the mission is where it was, and only a Jira fault is open.
  expect(p.mission(m.id)?.stage).toBe("build");
  expect(loop.health.open().map((f) => f.kind)).toEqual(["jira"]);
  fake.failComments = 0;
  p.clock.advance(301);
  await loop.pass();
  await loop.jiraIdle();
  expect(texts().some((t) => t.includes(`${WEB}3`))).toBe(true);
  p.cleanup();
});
