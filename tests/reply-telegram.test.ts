// The Telegram message when Towercab has answered the owner's comment and the PR waits for them again
// (LOOP-120), and the quiet for revisions Towercab started itself (LOOP-121).

import { expect, test } from "vitest";
import { Db } from "../src/db.ts";
import { apply, ok, wait } from "../src/machine.ts";
import { dataOf, getMission, insertMission, type Mission } from "../src/mission.ts";

const NOW = 1_793_000_000;
const PR = "https://github.com/me/web/pull/7";
const REPLY = "https://github.com/me/web/pull/7#issuecomment-100";
const NOTE = { gist: "Added the empty page case.", url: REPLY };

function world() {
  const db = Db.memory();
  const cx = {
    db,
    now: NOW,
    subject: (m: Mission) => ({ title: "Show a greeting", repo: m.repo, link: PR }),
  };
  let n = 0;
  /** A mission in the design stage whose data holds `data`. */
  const mk = (data: Record<string, unknown>) => {
    const m = insertMission(
      db,
      { intent: `261026-${String(1000 + n++)}`, slug: "x", repo: "web", model: "m", a: 2 },
      NOW,
    );
    db.run("UPDATE missions SET stage = 'design', step = '', data = ? WHERE id = ?", JSON.stringify(data), m.id);
    return getMission(db, m.id)!;
  };
  const texts = (m: Mission) =>
    db
      .all<{ mission: number; text: string }>("SELECT mission, text FROM outbox ORDER BY rowid")
      .filter((r) => r.mission === m.id)
      .map((r) => r.text);
  return { db, cx, mk, texts };
}

test("telegram: a posted reply sends one message with a link", () => {
  const w = world();
  const m = w.mk({ replyNote: NOTE });
  const moved = apply(w.cx, m, wait("approve spec"));
  expect(moved.stage).toBe("approval:spec");
  const sent = w.texts(m);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain(NOTE.gist);
  expect(sent[0]).toContain(REPLY);
  // Used once: the next wait is not told about the same reply.
  expect(dataOf(moved).replyNote).toBeUndefined();
});

test("telegram: the message names the intent, the PR and the gist", () => {
  const w = world();
  const m = w.mk({ replyNote: NOTE });
  apply(w.cx, m, wait("approve spec"));
  const text = w.texts(m)[0]!;
  expect(text).toContain("Show a greeting (web)");
  expect(text).toContain(`Towercab replied to your comment: ${NOTE.gist}`);
  expect(text.split("\n")).toContain(PR);
  expect(text.length).toBeLessThanOrEqual(4000);
  // A long first sentence is cut, so the links still fit.
  const long = world();
  const big = long.mk({ replyNote: { gist: "x".repeat(900), url: REPLY } });
  apply(long.cx, big, wait("approve spec"));
  const cut = long.texts(big)[0]!;
  expect(cut.length).toBeLessThanOrEqual(4000);
  expect(cut.split("\n")).toContain(PR);
});

test("telegram: a reply and the ready message are sent once", () => {
  const w = world();
  const m = w.mk({ replyNote: NOTE });
  apply(w.cx, m, wait("approve spec"));
  // One message carries both the ask and the reply.
  const sent = w.texts(m);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("Decide if this is the right change to build");
  expect(sent[0]).toContain("Towercab replied to your comment");
});

test("telegram: a revision Towercab started sends no reply message", () => {
  const w = world();
  // No reply was written, so there is no note: the usual message is sent as before (LOOP-16).
  const m = w.mk({});
  apply(w.cx, m, wait("approve spec"));
  const sent = w.texts(m);
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toContain("replied");
  expect(sent[0]).toBe(
    [
      "Decide if this is the right change to build: merge the spec PR to go ahead, or comment what to change.",
      "Show a greeting (web)",
      PR,
    ].join("\n"),
  );
});

test("telegram: a reply that leaves the PR not waiting sends nothing", () => {
  const w = world();
  const m = w.mk({ replyNote: NOTE });
  // The mission goes on without asking the owner: no message, and a question's message has no reply in it.
  apply(w.cx, m, ok());
  expect(w.texts(m)).toEqual([]);
  const asking = world();
  const q = asking.mk({ replyNote: NOTE });
  apply(asking.cx, q, wait("answer the question", "Which one?"));
  expect(asking.texts(q)).toHaveLength(1);
  expect(asking.texts(q)[0]).not.toContain("replied");
});
