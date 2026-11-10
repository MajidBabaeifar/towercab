import { describe, expect, test } from "vitest";
import { ChatRig, labels } from "./helpers/telegram.ts";

const flat = (t: string): string => t.replace(/\s+/g, " ");

/** The card messages sent (not the pings). */
const cards = (rig: ChatRig) => rig.sent().filter((s) => s.text.startsWith("<pre>"));

/** A rig with one merge wait delivered as the card, message 100. */
async function started(over: Parameters<ChatRig["wait"]>[1] = {}, rig = new ChatRig()) {
  const w = rig.wait("i-1", over);
  await rig.run();
  return { rig, w };
}

describe("telegram: one card per intent", () => {
  test("telegram: an intent has one card", async () => {
    const { rig } = await started();
    await rig.run();
    await rig.run();
    expect(rig.sent()).toHaveLength(1);
    expect(rig.sent()[0]!.text).toContain("◆ i-1");
    expect(rig.calls("sendMessage")[0]!.parse_mode).toBe("HTML");
    expect(rig.edits()).toEqual([]);
    expect(rig.db.all("SELECT message_id FROM tg_cards")).toEqual([{ message_id: 100 }]);
  });

  test("telegram: a stage change edits the card", async () => {
    const { rig, w } = await started();
    rig.work(w.id, "Building", 2);
    await rig.run();
    expect(rig.sent()).toHaveLength(1);
    expect(rig.edits()).toHaveLength(1);
    expect(rig.edits()[0]!.message).toBe(100);
    expect(flat(rig.edits()[0]!.text)).toContain("Building");
    expect(rig.calls("editMessageText")[0]!.parse_mode).toBe("HTML");
  });

  test("telegram: an unchanged card is not edited", async () => {
    const { rig, w } = await started();
    rig.work(w.id);
    await rig.run();
    await rig.run();
    await rig.run();
    expect(rig.edits()).toHaveLength(1);
  });

  test("telegram: an intent through all stages sends one message and several edits", async () => {
    const { rig, w } = await started({ question: true });
    rig.work(w.id, "Writing the spec", 0);
    await rig.run();
    rig.rewait(w.id, { question: false });
    await rig.run();
    rig.work(w.id, "Building", 2);
    await rig.run();
    rig.work(w.id, "Reviewing the change", 3);
    await rig.run();
    rig.rewait(w.id);
    await rig.run();
    rig.finish(w.id, "✅ done");
    await rig.run();
    expect(cards(rig)).toHaveLength(1);
    expect(rig.edits().length).toBeGreaterThanOrEqual(5);
    expect(rig.edits().every((e) => e.message === 100)).toBe(true);
    expect(rig.edits().at(-1)!.text).toContain("✅ done");
  });
});

describe("telegram: the card's buttons", () => {
  test("telegram: card buttons change with the state", async () => {
    const { rig, w } = await started();
    expect(labels(rig.sent()[0])).toEqual(["Merge", "Start over", "Drop"]);
    rig.rewait(w.id, { question: true });
    await rig.run();
    expect(rig.edits().at(-1)!.keyboard).toEqual([
      [{ text: "Drop", callback_data: expect.stringContaining(`|${w.id}.1`) }],
    ]);
    rig.rewait(w.id, { question: false, actions: ["retry"] });
    await rig.run();
    const kb = rig.edits().at(-1)!.keyboard as { text: string }[][];
    expect(kb.flat().map((b) => b.text)).toEqual(["Start over"]);
  });

  test("telegram: a handled wait leaves no buttons on the card", async () => {
    const { rig, w } = await started();
    rig.leave(w.id, "code_merged", "owner");
    await rig.run();
    expect(rig.edits().at(-1)!.keyboard).toEqual([]);
    // A press on the old button is refused and the card stays without buttons.
    const old = rig.data(rig.sent()[0], "Drop");
    rig.press(old, 100);
    await rig.run();
    expect(rig.answers()).toEqual(["That is already handled."]);
    expect(rig.edits().at(-1)!.keyboard).toEqual([]);
  });

  test("telegram: an owner-only card has no action buttons", async () => {
    const { rig } = await started({ onlyYou: true });
    expect(rig.sent()[0]!.keyboard).toBeUndefined();
    expect(flat(rig.sent()[0]!.text)).toContain("i-1 is only yours: use GitHub or the page");
  });
});

describe("telegram: a needs-you change pings", () => {
  test("telegram: a needs-you change sends a ping that replies to the card", async () => {
    const { rig, w } = await started();
    // The card's own first send is the notification: no ping with it.
    expect(rig.calls("sendMessage")).toHaveLength(1);
    rig.work(w.id);
    await rig.run();
    rig.rewait(w.id, { ask: "Answer the question", question: true });
    await rig.run();
    const sends = rig.calls("sendMessage");
    expect(sends).toHaveLength(2);
    expect(sends[1]!.reply_parameters).toEqual({ message_id: 100, allow_sending_without_reply: true });
    expect(String(sends[1]!.text).length).toBeLessThanOrEqual(60);
    expect(sends[1]!.text).toBe("Add export: Answer the question");
    expect(sends[1]!.disable_notification).toBeUndefined();
    expect(sends[1]!.reply_markup).toBeUndefined();
    await rig.run();
    expect(rig.calls("sendMessage")).toHaveLength(2);
  });

  test("telegram: an edit within the same wait sends no ping", async () => {
    const { rig, w } = await started();
    rig.work(w.id);
    await rig.run();
    rig.rewait(w.id);
    await rig.run();
    expect(rig.calls("sendMessage")).toHaveLength(2);
    // The same wait, a new reason: the card changes, the phone stays quiet.
    rig.cardState.set(w.id, rig.card(w.id, { ...rig.views[0]!, ask: "Review and merge it now" }));
    await rig.run();
    expect(rig.calls("sendMessage")).toHaveLength(2);
    expect(flat(rig.edits().at(-1)!.text)).toContain("merge it now");
    expect(rig.calls("deleteMessage")).toEqual([]);
  });

  test("telegram: a reply to the ping answers the question", async () => {
    const { rig, w } = await started();
    rig.work(w.id);
    await rig.run();
    rig.rewait(w.id, { question: true });
    await rig.run();
    const ping = rig.sent().at(-1)!;
    expect(ping.id).toBe(101);
    rig.say("Use Postgres", { replyTo: ping.id });
    await rig.run();
    expect(rig.actionCalls).toEqual(["guard i-1 reply telegram", "reply i-1 Use Postgres"]);
    // A reply to the card itself does the same.
    rig.say("Use SQLite", { replyTo: 100 });
    await rig.run();
    expect(rig.actionCalls.at(-1)).toBe("reply i-1 Use SQLite");
  });

  test("telegram: the ping is deleted when its wait ends", async () => {
    const { rig, w } = await started();
    rig.work(w.id);
    await rig.run();
    rig.rewait(w.id);
    await rig.run();
    rig.work(w.id, "Merging", 4);
    await rig.run();
    expect(rig.calls("deleteMessage")).toMatchObject([{ message_id: 101 }]);
    expect(rig.db.all("SELECT ping_id, ping_wait FROM tg_cards")).toEqual([
      { ping_id: null, ping_wait: null },
    ]);
    // A ping Telegram will not delete is dropped, not retried for ever.
    rig.refuseDeletes = true;
    rig.rewait(w.id);
    await rig.run();
    rig.work(w.id, "Merging", 4);
    await rig.run();
    await rig.run();
    expect(rig.calls("deleteMessage")).toHaveLength(2);
  });
});

describe("telegram: a finished intent's card stops changing", () => {
  test("telegram: a finished card shows the final state", async () => {
    const { rig, w } = await started();
    rig.finish(w.id, "✅ done");
    await rig.run();
    const last = rig.edits().at(-1)!;
    expect(last.text).toContain("✅ done");
    expect(last.text).toContain("spec ● plan ● build ● review ● merge ●".slice(0, 21));
    expect(last.keyboard).toEqual([]);
    expect(rig.db.all("SELECT final FROM tg_cards")).toEqual([{ final: 1 }]);
    // Unverified keeps its reason; an unverified intent with no card gets one.
    const other = new ChatRig();
    const x = other.wait("i-2");
    other.cardState.clear();
    other.finish(x.id, "⚠ unverified: no live check");
    await other.run();
    expect(cards(other)).toHaveLength(1);
    expect(flat(cards(other)[0]!.text)).toContain("⚠ unverified: no live check");
    // A done intent that never asked anything gets none.
    const quiet = new ChatRig();
    const y = quiet.wait("i-3");
    quiet.cardState.clear();
    quiet.db.run("DELETE FROM outbox");
    quiet.finish(y.id, "✅ done");
    await quiet.run();
    expect(quiet.sent()).toEqual([]);
  });

  test("telegram: a finished card is not edited again", async () => {
    const { rig, w } = await started();
    rig.finish(w.id, "🗑 dropped");
    await rig.run();
    const n = rig.edits().length;
    rig.work(w.id, "Building", 2);
    await rig.run();
    rig.rewait(w.id);
    await rig.run();
    await rig.run();
    expect(rig.edits()).toHaveLength(n);
    expect(rig.calls("sendMessage")).toHaveLength(1);
  });

  test("telegram: a restarted intent gets a new card", async () => {
    const { rig, w } = await started();
    rig.finish(w.id, "↩️ started over");
    await rig.run();
    rig.db.run("UPDATE missions SET stage = 'stopped' WHERE id = ?", w.id);
    const again = rig.wait("i-1");
    await rig.run();
    expect(again.id).not.toBe(w.id);
    expect(cards(rig)).toHaveLength(2);
    expect(rig.db.all("SELECT message_id, final FROM tg_cards ORDER BY mission")).toEqual([
      { message_id: 100, final: 1 },
      { message_id: 101, final: 0 },
    ]);
  });
});

describe("telegram: a card that cannot be edited is replaced", () => {
  test("telegram: a deleted card is replaced", async () => {
    const { rig, w } = await started();
    rig.refuseEdits = true;
    rig.work(w.id);
    await rig.run();
    expect(cards(rig)).toHaveLength(2);
    expect(flat(cards(rig)[1]!.text)).toContain("Building");
    expect(rig.logs.filter((l) => l.includes("cannot be edited"))).toHaveLength(1);
    // Only an intent that needs the owner is pinged for its replacement.
    expect(rig.calls("sendMessage")).toHaveLength(2);
    rig.rewait(w.id);
    await rig.run();
    expect(rig.calls("sendMessage")).toHaveLength(4);
    expect(rig.calls("sendMessage")[3]!.reply_parameters).toMatchObject({ message_id: 102 });
  });

  test("telegram: a replaced card keeps the new id", async () => {
    const { rig, w } = await started();
    rig.refuseEdits = true;
    rig.work(w.id);
    await rig.run();
    expect(rig.db.all("SELECT message_id FROM tg_cards")).toEqual([{ message_id: 101 }]);
    rig.refuseEdits = false;
    rig.work(w.id, "Reviewing the change", 3);
    await rig.run();
    expect(rig.edits().at(-1)!.message).toBe(101);
  });

  test("telegram: a transient failure keeps the old card id", async () => {
    const { rig, w } = await started();
    rig.failApi = true;
    rig.work(w.id);
    await rig.run();
    expect(rig.db.all("SELECT message_id, tries FROM tg_cards")).toEqual([{ message_id: 100, tries: 1 }]);
    rig.failApi = false;
    await rig.run();
    expect(rig.edits()).toHaveLength(1);
    rig.clock.advance(30);
    await rig.run();
    expect(rig.edits().at(-1)!.message).toBe(100);
    expect(rig.db.all("SELECT message_id, tries FROM tg_cards")).toEqual([{ message_id: 100, tries: 0 }]);
    expect(cards(rig)).toHaveLength(1);
  });
});
