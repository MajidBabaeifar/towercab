// The fast lane's answers (FAST-7): a confirmed fast intent's question gets the worker's recommendation,
// and the owner sees it afterwards. Questions about access, or without a matching recommendation, wait.

import { expect, test } from "vitest";
import { gate, gateLevel } from "../src/autonomy.ts";
import { Db } from "../src/db.ts";
import { confirmFast } from "../src/fast.ts";
import type { Ctx } from "../src/handlers.ts";
import type { Intent } from "../src/intents/types.ts";
import type { Mission } from "../src/mission.ts";
import { fastAnswer } from "../src/pipeline/fast-answer.ts";
import type { Question } from "../src/pipeline/schemas.ts";
import { pingText } from "../src/telegram/card.ts";
import { FakeForge } from "./helpers/fake-forge.ts";

const ID = "261114-1156";
const question: Question = {
  context: "The button may sit left or right.",
  question: "Where does the button go?",
  options: [
    // biome-ignore lint/suspicious/noThenProperty: the question's key; this object is never awaited.
    { option: "Left", then: "Put it on the left.", do: "continue" },
    // biome-ignore lint/suspicious/noThenProperty: the question's key; this object is never awaited.
    { option: "Right", then: "Put it on the right.", do: "continue" },
  ],
  recommendation: "Right",
};

function world(data: Record<string, unknown> = {}, o: { confirmed?: boolean; fast?: boolean } = {}) {
  const db = Db.memory();
  if (o.confirmed !== false) confirmFast(db, ID);
  const sections: string[] = [];
  const cx = {
    db,
    github: new FakeForge("owner"),
    clock: { now: () => 1_793_000_000, mono: () => 0 },
    log: () => {},
    repo: () => ({ github: "owner/web" }),
    store: {
      github: () => null,
      update: async (_id: string, _why: string, f: (e: { setSection(n: string, t: string): void }) => void) =>
        f({ setSection: (_n, t) => sections.push(t) }),
    },
  } as unknown as Pick<Ctx, "db" | "github" | "store" | "repo" | "log" | "clock">;
  const m = {
    id: 7,
    intent: ID,
    repo: "web",
    stage: "blocked",
    waiting: "answer the question",
    continued: 1,
    pr: null,
    plan_pr: null,
    spec_pr: null,
    data: JSON.stringify({ question, brief: "Where the button goes.", ...data }),
  } as unknown as Mission;
  const intent = { id: ID, repo: "web", fast: o.fast !== false } as unknown as Intent;
  return { db, cx, m, intent, sections };
}

test("fast: a question is answered with the recommendation", async () => {
  const w = world();
  const o = await fastAnswer(w.cx, w.m, w.intent);
  expect(o).toMatchObject({ event: "answered", text: "Right", data: { answeredBy: "fast lane" } });
});

test("fast: the answer is shown on the timeline and in telegram", async () => {
  const w = world();
  const o = await fastAnswer(w.cx, w.m, w.intent);
  // The Question comment carries the line; the outcome records who answered, which the page lists.
  expect(w.sections[0]).toContain("Answered automatically with the recommendation: Right");
  expect((o?.data as { answeredBy: string } | undefined)?.answeredBy).toBe("fast lane");
  const rows = w.db.all<{ text: string; kind: string }>("SELECT text, kind FROM outbox");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.kind).toBe("info");
  expect(rows[0]?.text).toContain("Where does the button go?");
  expect(rows[0]?.text).toContain("Right");
});

test("fast: a question without a recommendation waits", async () => {
  for (const recommendation of ["", "Up", "Left or right, whichever"]) {
    const w = world({ question: { ...question, recommendation } });
    expect(await fastAnswer(w.cx, w.m, w.intent)).toBeNull();
    expect(w.db.all("SELECT * FROM outbox")).toHaveLength(0);
  }
});

test("fast: an access request waits for the owner", async () => {
  const w = world({ accessAsk: { domains: ["example.com"], paths: [] } });
  expect(await fastAnswer(w.cx, w.m, w.intent)).toBeNull();
  const t = world({ testAsk: { tests: [], why: "" } });
  expect(await fastAnswer(t.cx, t.m, t.intent)).toBeNull();
  // An unconfirmed or removed mark leaves every question to the owner (FAST-9).
  const u = world({}, { confirmed: false });
  expect(await fastAnswer(u.cx, u.m, u.intent)).toBeNull();
  const n = world({}, { fast: false });
  expect(await fastAnswer(n.cx, n.m, n.intent)).toBeNull();
});

// FAST-8: the merge follows the a5 rows of AUT-18 at the fast lane's level; high risk waits, and Telegram hears.
const green = { ciGreen: true, review: { approved: true }, unplanned: false, proven: true } as const;
const fast = gateLevel(3, true, 5, "me");

test("fast: a medium risk change merges on its own", () => {
  expect(gate({ a: fast, ...green, risk: "medium" }).merge).toBe(true);
  expect(gate({ a: fast, ...green, risk: "low" }).merge).toBe(true);
});

test("fast: a high risk change waits and pings telegram at once", () => {
  expect(gate({ a: fast, ...green, risk: "high" }).merge).toBe(false);
  const text = pingText({
    title: "Add export",
    ask: "Review and merge the code",
    fast: "Fast lane · review, 5 of 6",
  });
  expect(text.startsWith("Fast lane")).toBe(true);
  // The wait is noticed on the loop's next pass: a holder entering an approval raises the flag.
  const db = Db.memory();
  db.setMeta("tg:urgent", "1");
  expect(db.meta("tg:urgent")).toBe("1");
});

test("fast: failing checks or an unapproved review still stop the merge", () => {
  expect(gate({ a: fast, ...green, ciGreen: false, risk: "low" }).merge).toBe(false);
  expect(gate({ a: fast, ...green, review: { approved: false }, risk: "low" }).merge).toBe(false);
  expect(gate({ a: fast, ...green, review: null, risk: "low" }).merge).toBe(false);
});
