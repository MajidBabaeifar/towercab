// Every Towercab comment names the agent and the intent (PIP-182, PIP-183); an agent's answer says so (PIP-185).

import { expect, test } from "vitest";
import {
  agentMarker,
  agentOf,
  agentOfBody,
  stageComment,
  upsertStageComment,
} from "../../src/github/comments.ts";
import { intakeNote } from "../../src/github/issues.ts";
import { agentReplyBody } from "../../src/github/owner.ts";
import type { Ctx } from "../../src/handlers.ts";
import type { Mission } from "../../src/mission.ts";
import { ask, tellOwner } from "../../src/pipeline/common.ts";
import { FakeTools, okResult } from "../helpers/tools.ts";
import { BOT, fakeGitHub } from "./fakes.ts";

const ID = "261105-2152-9";
const q = {
  context: "It is stuck.",
  question: "Which table?",
  options: [
    // biome-ignore lint/suspicious/noThenProperty: the spec's key; never awaited.
    { option: "a", then: "use a", do: "continue" as const },
  ],
  recommendation: "a",
};

/** A mission in `stage` with a code PR 7, and a context whose comments go through `tools`. */
function world(stage: string, data: object = {}) {
  const tools = new FakeTools().on("gh", (args) =>
    args[0] === "api" ? okResult("[]") : okResult("https://github.com/me/web/pull/7#issuecomment-1\n"),
  );
  const cx = {
    github: fakeGitHub(tools),
    repo: () => ({ github: "me/web" }),
    store: { github: () => "me/intents" },
    log: () => {},
  } as unknown as Ctx;
  const m = { intent: ID, stage, pr: 7, continued: 2, data: JSON.stringify(data) } as unknown as Mission;
  return { tools, cx, m };
}

const posted = (tools: FakeTools) => tools.calls.find((c) => c.args[0] === "pr" && c.args[1] === "comment")!;

test("github: stage comment names the agent and the intent", async () => {
  const text = stageComment("Question", 3, "Which table?", { agent: "designer", intent: ID });
  const lines = text.split("\n");
  // The marker is the edit-in-place key and does not change; the header gains the agent and the intent.
  expect(lines[0]).toBe("<!-- towercab:question:3 -->");
  expect(lines[1]).toBe(`**Question** · designer · ${ID} · round 3`);

  // The agent follows the stage that wrote the text; steps no agent wrote are Towercab's.
  expect(agentOf("Design")).toBe("designer");
  expect(agentOf("Plan")).toBe("planner");
  expect(agentOf("Build")).toBe("builder");
  expect(agentOf("Review")).toBe("reviewer");
  expect(agentOf("CI")).toBe("towercab");
  expect(agentOf("Question", "design")).toBe("designer");
  expect(agentOf("Question", "build")).toBe("builder");
  expect(agentOf("Answer", "approval:spec")).toBe("towercab");

  // A comment posted before this change (old header, same marker) is edited, not duplicated.
  const old = "<!-- towercab:question:3 -->\n**Question** · round 3\n\nbefore";
  const tools = new FakeTools().on("gh", (args) =>
    args[0] === "api" && args.includes("PATCH")
      ? okResult("{}")
      : okResult(JSON.stringify([{ id: 9, user: { login: BOT }, body: old }])),
  );
  const r = await upsertStageComment(fakeGitHub(tools), "me/web", 7, "Question", 3, "now", {
    agent: "designer",
    intent: ID,
  });
  expect(r).toEqual({ edited: true });
  expect(tools.lines("gh")[1]).toBe("api -X PATCH repos/me/web/issues/comments/9 --input -");
});

test("pipeline: question comment header carries the agent and intent", async () => {
  for (const [stage, agent] of [
    ["design", "designer"],
    ["plan", "planner"],
    ["build", "builder"],
  ] as const) {
    const { tools, cx, m } = world(stage);
    await ask(cx, m, q);
    const body = posted(tools).opts.input!;
    expect(body.split("\n")[0]).toBe("<!-- towercab:question:3 -->");
    expect(body.split("\n")[1], stage).toBe(`**Question** · ${agent} · ${ID} · round 3`);
  }
});

test("github: an issue intake note has the header and marker", () => {
  const note = intakeNote(2, ID, "This issue is queued as work for Towercab.");
  const lines = note.split("\n");
  expect(lines[0]).toBe("<!-- towercab:intake:2 -->");
  expect(lines[1]).toBe(`**Intake** · scorer · ${ID} · round 2`);
  expect(note).toContain("This issue is queued as work for Towercab.");
  // Before the intent exists, the issue number takes its place.
  expect(intakeNote(1, "#128", "written up").split("\n")[1]).toBe("**Intake** · scorer · #128 · round 1");
});

test("github: an intake note is written once", () => {
  // The same note kind has the same marker, so a repeat is found by it and edited, never added.
  expect(intakeNote(2, ID, "a").split("\n")[0]).toBe(intakeNote(2, ID, "b").split("\n")[0]);
  expect(intakeNote(1, ID, "a").split("\n")[0]).not.toBe(intakeNote(2, ID, "a").split("\n")[0]);
});

test("github: a stage comment says an agent answered for the owner", async () => {
  const agent = world("build", { answeredBy: "claude-code" });
  await tellOwner(agent.cx, agent.m, "Read your answer as: allow.");
  expect(posted(agent.tools).opts.input).toContain("Answered by claude-code, for the owner.");
  expect(posted(agent.tools).opts.input).toContain("Read your answer as: allow.");

  // The owner's own answer says nothing of the kind.
  const owner = world("build", { answeredBy: null });
  await tellOwner(owner.cx, owner.m, "Read your answer as: allow.");
  expect(posted(owner.tools).opts.input).not.toContain("Answered by");
});

test("github: the agent marker is read from the first line only", () => {
  const body = agentReplyBody("claude-code", "Majid", "hello");
  expect(body.split("\n")[0]).toBe(agentMarker("claude-code"));
  expect(agentOfBody(body)).toBe("claude-code");
  expect(agentOfBody(`quoting\n${agentMarker("x")}`)).toBeNull();
  expect(agentOfBody("plain comment")).toBeNull();
});
