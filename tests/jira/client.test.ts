// The Jira client against the fake Jira over real HTTP: JIRA-2 (only the filter's tickets, only the
// fields needed, comments read only for markers), JIRA-3 (repo selectors), JIRA-4 (pages, failures, rate
// limits), JIRA-6 (description to plain text), JIRA-10 (only comments are written), JIRA-11 (the fake).

import { afterEach, beforeEach, expect, test } from "vitest";
import type { JiraConfig } from "../../src/config.ts";
import { fetchHttp } from "../../src/github/app.ts";
import { adfToText } from "../../src/jira/adf.ts";
import { FIELDS, JiraClient, MAX_PAGES } from "../../src/jira/client.ts";
import { repoFor } from "../../src/jira/repos.ts";
import { FakeJira } from "../helpers/fake-jira.ts";

let fake: FakeJira;
let waits: number[];
beforeEach(async () => {
  fake = await new FakeJira().start();
  waits = [];
});
afterEach(() => fake.stop());

const client = (jql = "project = ABC ORDER BY created") =>
  new JiraClient(fake.config(jql), fetchHttp, async (ms) => {
    waits.push(ms);
  });

test("jira: a ticket outside the filter is never fetched", async () => {
  fake.ticket({ key: "ABC-1" });
  fake.ticket({ key: "ABC-2", summary: "SECRET-SUMMARY", inFilter: false });
  const c = client();
  const got = await c.eligible();
  expect(got.map((t) => t.key)).toEqual(["ABC-1"]);
  expect(await c.lookup("ABC-2")).toBeNull();
  // Every read was the search; none fetched a ticket by its key alone.
  expect(fake.seen.every((s) => s.path === "/rest/api/3/search/jql")).toBe(true);
  expect(fake.seen.map((s) => s.query.get("jql"))).toEqual([
    "project = ABC ORDER BY created",
    '(project = ABC) AND key = "ABC-2"',
  ]);
  expect(JSON.stringify(got)).not.toContain("SECRET");
  expect(fake.refused).toEqual([]);
});

test("jira: a lookup repeats the filter", async () => {
  fake.ticket({ key: "ABC-1" });
  const c = client("project = ABC AND labels = towercab order by rank DESC");
  expect((await c.lookup("ABC-1"))?.key).toBe("ABC-1");
  // The owner's clauses stay, the ordering goes, and the key is added as an `AND`.
  expect(fake.seen[0]!.query.get("jql")).toBe('(project = ABC AND labels = towercab) AND key = "ABC-1"');
  fake.byKey("ABC-1")!.inFilter = false;
  expect(await c.lookup("ABC-1")).toBeNull();
});

test("jira: only the needed fields are requested", async () => {
  fake.ticket({ key: "ABC-1" });
  await client().eligible();
  const q = fake.seen[0]!.query;
  expect(q.get("fields")).toBe("summary,description,project,components,labels");
  expect(FIELDS).toEqual(q.get("fields")!.split(","));
  expect(q.get("fields")).not.toMatch(/comment|attachment|assignee|reporter/);
});

test("jira: ticket comments are read only for the marker", async () => {
  fake.ticket({ key: "ABC-1" });
  fake.said("ABC-1", "Please do not read this: PASSWORD=hunter2 [towercab:queued:x]");
  fake.said("ABC-1", "an ordinary remark");
  const found = await client().findMarkers("ABC-1", ["towercab:queued:x", "towercab:done:x"]);
  // Only which of the asked-for markers exist comes back: no text, no author, no count.
  expect([...found]).toEqual(["towercab:queued:x"]);
  expect(fake.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /rest/api/3/issue/ABC-1/comment"]);
});

test("jira: a project selector picks the repo", () => {
  const cfg: JiraConfig = {
    ...fake.config(),
    repos: new Map([
      ["web", [{ kind: "project" as const, value: "abc" }]],
      ["api", [{ kind: "project" as const, value: "xyz" }]],
    ]),
  };
  const t = (project: string) => ({
    key: `${project}-1`,
    summary: "",
    description: null,
    project,
    components: [],
    labels: [],
  });
  expect(repoFor(cfg, t("ABC"))).toEqual({ repo: "web" });
  expect(repoFor(cfg, t("xyz"))).toEqual({ repo: "api" });
  expect(repoFor(cfg, t("OTHER"))).toEqual({ skip: "no repo's selectors match it" });
});

test("jira: a component or label selector picks the repo", () => {
  const cfg: JiraConfig = {
    ...fake.config(),
    repos: new Map([
      ["web", [{ kind: "component" as const, value: "billing" }]],
      ["api", [{ kind: "label" as const, value: "backend" }]],
    ]),
  };
  const t = (o: { components?: string[]; labels?: string[] }) => ({
    key: "ABC-1",
    summary: "",
    description: null,
    project: "ABC",
    components: o.components ?? [],
    labels: o.labels ?? [],
  });
  expect(repoFor(cfg, t({ components: ["Billing"] }))).toEqual({ repo: "web" });
  expect(repoFor(cfg, t({ labels: ["Backend"] }))).toEqual({ repo: "api" });
  // Exact, not a substring.
  expect("skip" in repoFor(cfg, t({ components: ["Billing UI"] }))).toBe(true);
});

test("jira: an ambiguous ticket is skipped", () => {
  const cfg: JiraConfig = {
    ...fake.config(),
    repos: new Map([
      ["web", [{ kind: "project" as const, value: "abc" }]],
      ["api", [{ kind: "label" as const, value: "backend" }]],
    ]),
  };
  const r = repoFor(cfg, {
    key: "ABC-1",
    summary: "",
    description: null,
    project: "ABC",
    components: [],
    labels: ["backend"],
  });
  expect(r).toEqual({ skip: "web and api both match it" });
});

test("jira: the poll continues on the next page", async () => {
  fake.pageSize = 2;
  for (let n = 1; n <= 5; n++) fake.ticket({ key: `ABC-${n}` });
  const got = await client().eligible();
  expect(got.map((t) => t.key)).toEqual(["ABC-1", "ABC-2", "ABC-3", "ABC-4", "ABC-5"]);
  expect(fake.seen.map((s) => s.query.get("nextPageToken"))).toEqual([null, "2", "4"]);
  // At most four pages in a pass; what is beyond waits for the next one.
  fake.seen.length = 0;
  fake.pageSize = 1;
  const few = await client().eligible();
  expect(few).toHaveLength(MAX_PAGES);
  expect(fake.seen).toHaveLength(MAX_PAGES);
});

test("jira: a Jira failure is a Jira fault", async () => {
  fake.ticket({ key: "ABC-1" });
  fake.failNext = { status: 503, times: 1 };
  await expect(client().eligible()).rejects.toThrow("Jira GET /rest/api/3/search/jql: HTTP 503");
  // A wrong token is a fault of Jira's account, named without the secret.
  const bad = new JiraClient({ ...fake.config(), email: "someone@else.com" }, fetchHttp);
  const e = await bad.eligible().catch((x: Error) => x);
  expect((e as Error).message).toBe("Jira GET /rest/api/3/search/jql: HTTP 401");
});

test("jira: a rate limit waits for Retry-After", async () => {
  fake.ticket({ key: "ABC-1" });
  fake.failNext = { status: 429, retryAfter: "7", times: 1 };
  expect((await client().eligible()).map((t) => t.key)).toEqual(["ABC-1"]);
  expect(waits).toEqual([7000]);
  // Still limited after the waits: the pass ends, and nothing else is written.
  fake.failNext = { status: 429, retryAfter: "3", times: 9 };
  waits.length = 0;
  await expect(client().eligible()).rejects.toThrow("HTTP 429");
  expect(waits).toEqual([3000, 3000]);
});

test("jira: a description becomes plain text", () => {
  const doc = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Accountants need " },
          { type: "text", text: "a CSV", marks: [{ type: "strong" }] },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "per currency" }] }],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "see " },
                  {
                    type: "text",
                    text: "the spec",
                    marks: [{ type: "link", attrs: { href: "https://x.test/spec" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "orderedList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
        ],
      },
      { type: "codeBlock", content: [{ type: "text", text: "SELECT 1;" }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "secret-media-id" } }] },
      {
        type: "paragraph",
        content: [
          { type: "mention", attrs: { id: "acct-123", text: "@Ana" } },
          { type: "text", text: " please check" },
        ],
      },
    ],
  };
  expect(adfToText(doc)).toBe(
    [
      "Accountants need a CSV",
      "- per currency",
      "- see the spec (https://x.test/spec)",
      "1. first",
      "```",
      "SELECT 1;",
      "```",
      "@Ana please check",
    ].join("\n"),
  );
  expect(adfToText(doc)).not.toMatch(/secret-media-id|acct-123/);
  expect(adfToText("  already plain  ")).toBe("already plain");
});

test("jira: only comments are written to Jira", async () => {
  fake.ticket({ key: "ABC-1" });
  const c = client();
  await c.eligible();
  await c.lookup("ABC-1");
  await c.findMarkers("ABC-1", ["x"]);
  await c.addComment("ABC-1", "Work has started: https://github.com/o/r/pull/1");
  const w = fake.writes();
  expect(w.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /rest/api/3/issue/ABC-1/comment"]);
  // The comment's link is a link in Jira's document format; nothing else is in the body.
  expect(JSON.stringify(w[0]!.body)).toContain('"type":"link"');
  expect(Object.keys(w[0]!.body as object)).toEqual(["body"]);
  // The client has no way to transition, assign, edit or label a ticket.
  expect(
    Object.getOwnPropertyNames(JiraClient.prototype).filter((n) => !n.startsWith("constructor")),
  ).toEqual(expect.not.arrayContaining(["transition", "assign", "edit", "setLabels"]));
  expect(fake.refused).toEqual([]);
});

test("jira: the fake refuses a call outside the search and comment endpoints", async () => {
  fake.ticket({ key: "ABC-1" });
  const auth = `Basic ${Buffer.from("owner@example.com:jira-secret-token").toString("base64")}`;
  for (const [method, path] of [
    ["GET", "/rest/api/3/issue/ABC-1"],
    ["POST", "/rest/api/3/issue/ABC-1/transitions"],
    ["PUT", "/rest/api/3/issue/ABC-1"],
    ["GET", "/rest/api/3/project"],
    ["DELETE", "/rest/api/3/issue/ABC-1/comment"],
  ] as const) {
    const r = await fetch(`${fake.site}${path}`, { method, headers: { Authorization: auth } });
    expect(r.status, `${method} ${path}`).toBe(404);
  }
  expect(fake.refused).toHaveLength(5);
  // The implemented calls need the right basic auth.
  const noAuth = await fetch(`${fake.site}/rest/api/3/search/jql?jql=x`);
  expect(noAuth.status).toBe(401);
  const ok = await fetch(`${fake.site}/rest/api/3/search/jql?jql=x`, { headers: { Authorization: auth } });
  expect(ok.status).toBe(200);
});
