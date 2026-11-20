// CHAT-3..9: an intent's thread from its run files and Claude transcripts, paging, a gone transcript,
// and the owner's messages queued until the intent waits on them.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Db } from "../../src/db.ts";
import { getMission, insertMission } from "../../src/mission.ts";
import { createActions } from "../../src/ui/actions.ts";
import {
  chatOf,
  composerOf,
  keepTranscript,
  PAGE,
  parseTranscript,
  queuedOf,
  runsOf,
  saveQueued,
  transcriptPath,
} from "../../src/ui/chat.ts";
import { tempDir, testDb } from "../helpers/world.ts";

const line = (o: object) => JSON.stringify(o);

/** Put a mission at a stage directly: only the state machine moves missions in Towercab itself. */
function stageTo(db: Db, id: number, stage: string) {
  db.run("UPDATE missions SET stage = ? WHERE id = ?", stage, id);
  return getMission(db, id)!;
}

/** A run result naming `session`, and the session's transcript under a fake `~/.claude/projects`. */
function world(turns: string[] = [], o: { transcript?: boolean } = {}) {
  const runs = tempDir("tc-runs-");
  const claude = tempDir("tc-claude-");
  const stage = join(runs, "261101-0900", "build");
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, "worker-1.json"), line({ type: "result", session_id: "s-1" }));
  if (o.transcript !== false) {
    const proj = join(claude, "projects", "-work-x");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s-1.jsonl"), turns.join("\n"));
  }
  return { runs, claude, stage };
}

const TRANSCRIPT = [
  line({ type: "user", timestamp: "2026-11-19T10:00:00Z", message: { content: "Build step 1." } }),
  line({
    type: "assistant",
    timestamp: "2026-11-19T10:00:05Z",
    message: {
      content: [
        { type: "text", text: "Reading the file." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      ],
    },
  }),
  line({
    type: "user",
    timestamp: "2026-11-19T10:00:06Z",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "export const a = 1;" }] },
  }),
  line({
    type: "assistant",
    timestamp: "2026-11-19T10:00:09Z",
    message: { content: [{ type: "text", text: "Done." }] },
  }),
];

test("chat: a run's transcript becomes messages with tool calls folded", () => {
  const w = world(TRANSCRIPT);
  const [run] = runsOf(w.runs, "261101-0900");
  expect(run).toMatchObject({ stage: "build", kind: "worker", n: 1, session: "s-1" });
  const msgs = parseTranscript(TRANSCRIPT.join("\n"), run!);
  expect(msgs.map((m) => m.role)).toEqual(["prompt", "agent", "agent"]);
  expect(msgs[1]!.tools).toEqual([
    { name: "Read", input: '{"file_path":"a.ts"}', result: "export const a = 1;", error: false },
  ]);
  expect(msgs[2]!.text).toBe("Done.");
});

test("chat: tool-only turns join the agent message before them", () => {
  const w = world(TRANSCRIPT);
  const [run] = runsOf(w.runs, "261101-0900");
  const call = (id: string, at: string) =>
    line({
      type: "assistant",
      timestamp: at,
      message: { content: [{ type: "tool_use", id, name: "Edit", input: {} }] },
    });
  const t = [
    TRANSCRIPT[0]!,
    TRANSCRIPT[1]!,
    call("t2", "2026-11-19T10:00:07Z"),
    call("t3", "2026-11-19T10:00:08Z"),
    TRANSCRIPT[3]!,
  ];
  const msgs = parseTranscript(t.join("\n"), run!);
  expect(msgs.map((m) => m.role)).toEqual(["prompt", "agent", "agent"]);
  expect(msgs[1]!.tools.map((x) => x.name)).toEqual(["Read", "Edit", "Edit"]);
});

test("chat: Towercab's own copy of a transcript is preferred and kept at run end", () => {
  const w = world(TRANSCRIPT);
  const [run] = runsOf(w.runs, "261101-0900");
  expect(transcriptPath(run!, w.claude)).toBe(join(w.claude, "projects", "-work-x", "s-1.jsonl"));
  keepTranscript(join(w.stage, "worker-1.json"), w.claude);
  const copy = join(w.stage, "worker-1.transcript.jsonl");
  expect(existsSync(copy)).toBe(true);
  expect(transcriptPath(run!, w.claude)).toBe(copy);
});

test("chat: a gone transcript leaves a note, not an error", () => {
  const w = world([], { transcript: false });
  const page = chatOf({ db: testDb(), runsRoot: w.runs, claudeHome: w.claude }, "261101-0900", []);
  expect(page.missing).toBe(1);
  expect(page.items.map((i) => i.type)).toEqual(["divider", "event"]);
  // No attempt yet: the composer stays open and the message waits.
  expect(page.composer.open).toBe(true);
});

test("chat: a long thread loads the latest page first and pages back", () => {
  const many = Array.from({ length: PAGE + 50 }, (_, i) =>
    line({
      type: "assistant",
      timestamp: new Date(Date.UTC(2026, 10, 19, 10, 0, i)).toISOString(),
      message: { content: [{ type: "text", text: `turn ${i}` }] },
    }),
  );
  const w = world(many);
  const d = { db: testDb(), runsRoot: w.runs, claudeHome: w.claude };
  const last = chatOf(d, "261101-0900", []);
  expect(last.total).toBe(PAGE + 51);
  expect(last.items).toHaveLength(PAGE);
  expect(last.before).toBe(51);
  const first = chatOf(d, "261101-0900", [], last.before!);
  expect(first.items).toHaveLength(51);
  expect(first.before).toBeNull();
});

test("chat: the composer says whether a message goes in now or waits", () => {
  const db = testDb();
  const m = insertMission(db, { intent: "261101-0900", slug: "x", repo: "r", model: "sonnet", a: 5 }, 1);
  expect(composerOf(null).open).toBe(false);
  expect(composerOf(stageTo(db, m.id, "build")).note).toMatch(/waits/);
  expect(composerOf(stageTo(db, m.id, "approval:plan")).note).toMatch(/goes to it now/);
});

test("chat: a message waits while a worker runs and goes in as a reply once the intent waits on the owner", async () => {
  const db = testDb();
  const m = insertMission(db, { intent: "261101-0900", slug: "x", repo: "r", model: "sonnet", a: 5 }, 1);
  stageTo(db, m.id, "build");
  const replies: string[] = [];
  const a = createActions({
    db,
    store: { github: () => null } as never,
    config: {} as never,
    clock: { now: () => 10 } as never,
    github: { owner: null } as never,
  });
  a.reply = async (_i, text) => {
    replies.push(text);
    return "Replied.";
  };
  expect(await a.chat!("261101-0900", "Use the existing helper.")).toMatch(/Queued/);
  expect(replies).toEqual([]);
  stageTo(db, m.id, "blocked");
  await a.deliverChats!();
  expect(replies).toEqual(["Use the existing helper."]);
  expect(queuedOf(db, "261101-0900")[0]).toMatchObject({ status: "sent", note: "Replied." });
});

test("chat: an ended intent takes no message, and a queued one is marked failed", async () => {
  const db = testDb();
  const a = createActions({
    db,
    store: { github: () => null } as never,
    config: {} as never,
    clock: { now: () => 10 } as never,
    github: { owner: null } as never,
  });
  const m = insertMission(db, { intent: "261101-0900", slug: "x", repo: "r", model: "sonnet", a: 5 }, 1);
  stageTo(db, m.id, "done");
  await expect(a.chat!("261101-0900", "hello")).rejects.toThrow(/has ended/);
  saveQueued(db, "261101-0900", [{ id: 1, at: 1, by: "you", text: "x", status: "queued", note: null }]);
  await a.deliverChats!();
  expect(queuedOf(db, "261101-0900")[0]).toMatchObject({ status: "failed", note: "The intent ended first." });
});
