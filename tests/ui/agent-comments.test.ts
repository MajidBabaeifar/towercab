// PIP-186: the intent page lists the comments agents wrote under the owner's login, and a card says
// when an agent answered for the owner.

import { afterEach, expect, test } from "vitest";
import { recordAgentComment } from "../../src/commands.ts";
import { intentPage, overview } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";

const NOW = new Date(2026, 9, 26, 23, 0, 0).getTime() / 1000;
const open: Fixture[] = [];
afterEach(() => {
  while (open.length) open.pop()!.cleanup();
});

const world = () => {
  const f = buildFixture({ now: NOW });
  open.push(f);
  return f;
};

test("ui: the intent api returns agent comments", async () => {
  const f = world();
  expect((await intentPage(f.sources, IDS.question))!.agent_comments).toEqual([]);

  recordAgentComment(f.db, IDS.question, "code:agent:c1", {
    agent: "claude-code",
    url: "https://github.com/me/web/pull/7",
    at: NOW - 120,
    excerpt: "🤖 claude-code (for Majid) Use the other table.",
    actedOn: true,
  });
  recordAgentComment(f.db, IDS.question, "code:agent:c2", {
    agent: "shadow",
    url: "https://github.com/me/web/pull/7",
    at: NOW - 60,
    excerpt: "second",
    actedOn: false,
  });
  // The wire shape is the JSON the route sends: snake_case `agent_comments`, oldest first.
  const wire = JSON.parse(JSON.stringify(await intentPage(f.sources, IDS.question)));
  expect(wire.agent_comments.map((c: { agent: string }) => c.agent)).toEqual(["claude-code", "shadow"]);
  expect(wire.agent_comments[0]).toMatchObject({
    agent: "claude-code",
    url: "https://github.com/me/web/pull/7",
    excerpt: "🤖 claude-code (for Majid) Use the other table.",
    acted_on: true,
  });
  expect(wire.agent_comments[0].at).toBeTruthy();
  expect(wire.agent_comments[1].acted_on).toBe(false);
  // Another intent's page has none of them.
  expect((await intentPage(f.sources, IDS.plan))!.agent_comments).toEqual([]);
});

test("ui: the intent page lists agent comments written under the owner's login", async () => {
  const f = world();
  recordAgentComment(f.db, IDS.question, "code:agent:c1", {
    agent: "claude-code",
    url: "https://github.com/me/web/pull/7",
    at: NOW - 120,
    excerpt: "Use the other table.",
    actedOn: true,
  });
  const page = (await intentPage(f.sources, IDS.question))!;
  expect(page.agent_comments).toHaveLength(1);
  expect(page.agent_comments[0]).toMatchObject({ agent: "claude-code", excerpt: "Use the other table." });
});

test("ui: a card shows agent for owner after an agent's answer", async () => {
  const f = world();
  const card = async () => (await overview(f.sources)).needs.find((c) => c.intent === IDS.question)!;
  expect((await card()).decided_by_agent).toBeUndefined();
  const row = f.db.get<{ id: number; data: string | null }>(
    "SELECT id, data FROM missions WHERE intent = ?",
    IDS.question,
  )!;
  const data = { ...JSON.parse(row.data ?? "{}"), answeredBy: "claude-code" };
  f.db.run("UPDATE missions SET data = ? WHERE id = ?", JSON.stringify(data), row.id);
  expect((await card()).decided_by_agent).toBe("claude-code");
});
