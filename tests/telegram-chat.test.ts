import { describe, expect, test } from "vitest";
import { ChatRig, labels } from "./helpers/telegram.ts";

/** A card's lines joined with single spaces, so a sentence the card wraps can be found. */
const flat = (t: string): string => t.replace(/\s+/g, " ");

/** A rig with one merge wait delivered as message 100. */
async function started(over: Parameters<ChatRig["wait"]>[1] = {}, rig = new ChatRig()) {
  const w = rig.wait("i-1", over);
  await rig.run();
  return { rig, w, msg: rig.sent()[0]! };
}

describe("telegram: who and what", () => {
  test("telegram: updates from another chat are ignored and logged", async () => {
    const rig = new ChatRig();
    rig.say("/status", { chat: "99" });
    await rig.run();
    expect(rig.sent()).toEqual([]);
    expect(rig.db.all("SELECT 1 FROM telegram_updates")).toHaveLength(0);
    expect(rig.logs.filter((l) => l.includes("ignored update 1 from chat 99 (message)"))).toHaveLength(1);
    expect(rig.logs.join()).not.toContain("/status");
    expect(rig.logs.join()).not.toContain("tok");
    expect(rig.db.meta("telegram.offset")).toBe("2");
  });

  test("telegram: a button press from another chat does nothing", async () => {
    const { rig, msg } = await started();
    rig.press(rig.data(msg, "Drop"), 100, "99");
    await rig.run();
    expect(rig.actionCalls).toEqual([]);
    expect(rig.answers()).toEqual([]);
    expect(rig.edits()).toEqual([]);
    expect(rig.logs.some((l) => l.includes("(button)"))).toBe(true);
  });

  test("telegram: buttons call the actions API", async () => {
    const { rig, msg } = await started();
    rig.press(rig.data(msg, "Start over"), 100);
    await rig.run();
    expect(rig.actionCalls).toEqual(["guard i-1 retry telegram", "retry i-1"]);
    expect(rig.answers()).toEqual(["retry done"]);
  });

  test("telegram: a refusal reads as on the page", async () => {
    const { rig, msg } = await started();
    rig.actionFails.retry = "GitHub refused to comment on the code PR: nope";
    rig.press(rig.data(msg, "Start over"), 100);
    await rig.run();
    expect(rig.answers()).toEqual(["GitHub refused to comment on the code PR: nope"]);
    expect(rig.edits().filter((e) => e.text.includes("started over"))).toEqual([]);
  });

  test("telegram: no action the page lacks", async () => {
    const { rig } = await started();
    for (const text of ["/start", "/merge i-1", "/drop i-1", "/approve i-1"]) rig.say(text);
    await rig.run();
    expect(rig.actionCalls).toEqual([]);
    expect(
      rig
        .sent()
        .slice(1)
        .every((s) => s.text.includes("/status")),
    ).toBe(true);
  });

  test("telegram: an a0 message has no action buttons", async () => {
    const { msg } = await started({ onlyYou: true });
    expect(msg.keyboard).toBeUndefined();
    expect(flat(msg.text)).toContain("i-1 is only yours: use GitHub or the page");
  });

  test("telegram: a button on an a0 intent is refused", async () => {
    const { rig, msg } = await started();
    rig.a0.add("i-1");
    rig.views[0]!.onlyYou = true;
    rig.press(rig.data(msg, "Drop"), 100);
    await rig.run();
    expect(rig.answers()).toEqual(["i-1 is only yours: use GitHub or the page"]);
    expect(rig.actionCalls.filter((c) => !c.startsWith("guard"))).toEqual([]);
  });

  test("telegram: a reply to an a0 question is not an answer", async () => {
    const { rig } = await started({ question: true, onlyYou: true });
    rig.say("Use Postgres", { replyTo: 100 });
    await rig.run();
    expect(rig.actionCalls).toEqual([]);
    expect(rig.sent()[1]!.text).toBe("i-1 is only yours: use GitHub or the page");
  });

  test("telegram: pause and resume work with a0 intents", async () => {
    const rig = new ChatRig();
    rig.a0.add("i-1");
    rig.wait("i-1", { onlyYou: true });
    rig.say("/pause");
    await rig.run();
    expect(rig.sent().map((x) => x.text)).toContain("Paused.");
    rig.say("/resume");
    await rig.run();
    expect(rig.sent().map((x) => x.text)).toContain("Resumed.");
  });
});

describe("telegram: buttons", () => {
  test("telegram: a needs-you message has the card's buttons", async () => {
    const { msg } = await started();
    expect(labels(msg)).toEqual(["Merge", "Start over", "Drop"]);
    expect(flat(msg.text)).toContain("Review and merge the code");
    const r2 = new ChatRig();
    r2.wait("i-2", { actions: ["retry"] });
    await r2.run();
    expect(labels(r2.sent()[0])).toEqual(["Start over"]);
    const r3 = new ChatRig();
    r3.wait("i-3", { actions: [] });
    await r3.run();
    expect(r3.sent()[0]!.keyboard).toBeUndefined();
  });

  test("telegram: a question has no merge button", async () => {
    const { msg } = await started({ question: true, actions: ["merge", "retry", "drop"] });
    expect(labels(msg)).toEqual(["Drop"]);
    expect(flat(msg.text)).toContain("Reply to answer.");
  });

  test("telegram: a proposed intent has accept and close", async () => {
    const rig = new ChatRig();
    const p = {
      pr: 12,
      head: "a".repeat(40),
      title: "New idea",
      repo: "web",
      url: "https://github.com/o/intents/pull/12",
    };
    rig.proposals = [p];
    rig.focusPick = { wait: null, proposal: p, more: 0 };
    rig.say("/focus");
    await rig.run();
    const m = rig.sent()[0]!;
    expect(labels(m)).toEqual(["Accept", "Close"]);
    rig.press(rig.data(m, "Accept"), 100);
    await rig.run();
    expect(rig.actionCalls).toEqual([`accept 12 ${"a".repeat(40)}`]);
    expect(rig.edits().at(-1)!.text).toContain("✅ accepted by you");
  });

  test("telegram: callback data fits 64 bytes", async () => {
    const long = `${"x".repeat(50)}-intent`;
    const { rig, msg } = await started({ intent: long });
    for (const b of (msg.keyboard ?? []).flat())
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    const short = new ChatRig();
    short.wait("261105-2152-7");
    await short.run();
    for (const b of short.sent()[0]!.keyboard!.flat())
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    void rig;
  });
});

describe("telegram: confirms", () => {
  test("telegram: merge asks to confirm", async () => {
    const { rig, msg } = await started();
    rig.press(rig.data(msg, "Merge"), 100);
    await rig.run();
    expect(rig.actionCalls.filter((c) => c.startsWith("merge"))).toEqual([]);
    const e = rig.edits()[0]!;
    expect(e.text).toBe("Merge the code PR #7 of Add export into main?");
    expect((e.keyboard as { text: string }[][]).flat().map((b) => b.text)).toEqual(["Yes, merge", "Cancel"]);
    const yes = (e.keyboard as { text: string; callback_data: string }[][]).flat()[0]!.callback_data;
    rig.press(yes, 100);
    await rig.run();
    expect(rig.actionCalls.filter((c) => c.startsWith("merge"))).toEqual(["merge i-1"]);
  });

  test("telegram: drop asks to confirm", async () => {
    const { rig, msg } = await started();
    rig.press(rig.data(msg, "Drop"), 100);
    await rig.run();
    const e = rig.edits()[0]!;
    expect(e.text).toBe("Drop Add export? This closes its PR.");
    expect((e.keyboard as { text: string }[][]).flat().map((b) => b.text)).toEqual(["Yes, drop", "Cancel"]);
    rig.press((e.keyboard as { callback_data: string }[][]).flat()[0]!.callback_data, 100);
    await rig.run();
    expect(rig.actionCalls.filter((c) => c.startsWith("drop"))).toEqual(["drop i-1"]);
  });

  test("telegram: cancel restores the buttons", async () => {
    const { rig, msg } = await started();
    rig.press(rig.data(msg, "Drop"), 100);
    await rig.run();
    const cancel = (rig.edits()[0]!.keyboard as { text: string; callback_data: string }[][]).flat()[1]!;
    rig.press(cancel.callback_data, 100);
    await rig.run();
    const back = rig.edits()[1]!;
    expect(back.text).toBe(msg.text);
    expect((back.keyboard as { text: string }[][]).flat().map((b) => b.text)).toEqual([
      "Merge",
      "Start over",
      "Drop",
    ]);
  });

  test("telegram: an unconfirmed merge or drop changes nothing", async () => {
    const { rig, msg } = await started();
    rig.press(rig.data(msg, "Merge"), 100);
    rig.press(rig.data(msg, "Drop"), 100);
    await rig.run();
    await rig.run();
    expect(rig.actionCalls.filter((c) => /^(merge|drop|retry)/.test(c))).toEqual([]);
  });

  test("telegram: a merge confirm for a moved head is refused", async () => {
    const { rig, msg } = await started();
    rig.press(rig.data(msg, "Merge"), 100);
    await rig.run();
    const yes = (rig.edits()[0]!.keyboard as { callback_data: string }[][]).flat()[0]!.callback_data;
    rig.heads["i-1"] = "ffffffffff";
    rig.press(yes, 100);
    await rig.run();
    expect(rig.actionCalls.filter((c) => c.startsWith("merge"))).toEqual([]);
    expect(rig.answers().at(-1)).toBe("That has changed.");
  });

  test("telegram: other actions act on the first press", async () => {
    const { rig, msg } = await started();
    rig.press(rig.data(msg, "Start over"), 100);
    await rig.run();
    expect(rig.actionCalls).toContain("retry i-1");
    // The card is brought up to date at once (TG-19): the fake page has not moved yet, so it shows the wait.
    expect(rig.edits().at(-1)!.text).toMatch(/^<pre>/);
  });
});

describe("telegram: stale buttons", () => {
  test("telegram: a stale button is refused and answered", async () => {
    const { rig, msg } = await started();
    const drop = rig.data(msg, "Drop");
    rig.views = [];
    rig.press(drop, 100);
    await rig.run();
    expect(rig.answers()).toEqual(["That is already handled."]);
    const again = new ChatRig();
    const w = again.wait("i-1");
    await again.run();
    const old = again.data(again.sent()[0], "Drop");
    again.views = [{ ...w.view, waitId: `${w.id}.1` }];
    again.press(old, 100);
    await again.run();
    expect(again.answers()).toEqual(["That has changed."]);
    expect(again.actionCalls).toEqual([]);
  });

  test("telegram: a button for an ended wait edits the message", async () => {
    const { rig, msg, w } = await started();
    const drop = rig.data(msg, "Drop");
    rig.leave(w.id, "code_merged", "owner");
    rig.press(drop, 100);
    await rig.run();
    expect(flat(rig.edits().at(-1)!.text)).toContain("Building");
    expect(rig.edits().at(-1)!.keyboard).toEqual([]);
    expect(rig.actionCalls).toEqual([]);
  });
});

describe("telegram: replies", () => {
  test("telegram: replying to a question answers it", async () => {
    const { rig } = await started({ question: true });
    rig.say("Use Postgres", { replyTo: 100 });
    await rig.run();
    expect(rig.actionCalls).toEqual(["guard i-1 reply telegram", "reply i-1 Use Postgres"]);
    expect(rig.sent().at(-1)!.text).toBe("reply done");
  });

  test("telegram: a reply to a notice is not an answer", async () => {
    const rig = new ChatRig();
    rig.db.run(
      "INSERT INTO outbox (key, mission, text, created, sent_at, tg_message_id, kind) VALUES ('n', NULL, 'Run finished', 1, 1, 555, 'info')",
    );
    rig.say("thanks", { replyTo: 555 });
    await rig.run();
    expect(rig.actionCalls).toEqual([]);
    expect(rig.sent()[0]!.text).toContain("/status");
  });

  test("telegram: plain text is never an answer", async () => {
    const { rig } = await started({ question: true });
    rig.say("Use Postgres");
    await rig.run();
    expect(rig.actionCalls).toEqual([]);
    expect(rig.sent()[1]!.text).toContain("Reply to a question to answer it");
  });
});

describe("telegram: pause, resume and help", () => {
  test("telegram: pause and resume insert the commands", async () => {
    const rig = new ChatRig();
    rig.runningRows = [
      { intent: "i-1", title: "A", step: "build" },
      { intent: "i-2", title: "B", step: "verify" },
    ];
    rig.say("/pause");
    await rig.run();
    expect(rig.sent()[0]!.text).toBe("Paused. 2 steps are finishing.");
    expect(rig.db.all<{ name: string; arg: string }>("SELECT name, arg FROM commands")).toEqual([
      { name: "pause", arg: "" },
    ]);
    rig.db.run("UPDATE commands SET applied_at = 1");
    rig.db.setMeta("paused", "1");
    rig.say("/resume");
    await rig.run();
    expect(rig.sent()[1]!.text).toBe("Resumed.");
    expect(rig.db.all("SELECT 1 FROM commands WHERE name = 'resume'")).toHaveLength(1);
  });

  test("telegram: pausing twice says so", async () => {
    const rig = new ChatRig();
    rig.say("/pause");
    rig.say("/pause");
    rig.say("/resume");
    rig.say("/resume");
    await rig.run();
    expect(rig.sent().map((s) => s.text)).toEqual(["Paused.", "Already paused.", "Resumed.", "Not paused."]);
    expect(rig.db.all("SELECT 1 FROM commands")).toHaveLength(2);
  });

  test("telegram: unknown command gets the help line", async () => {
    const rig = new ChatRig();
    rig.say("/dance");
    rig.say("hello");
    await rig.run();
    expect(rig.sent().map((s) => s.text)).toEqual([
      "I understand /status, /focus, /queue, /pause, /resume and /fast. Reply to a question to answer it.",
      "I understand /status, /focus, /queue, /pause, /resume and /fast. Reply to a question to answer it.",
    ]);
  });

  test("telegram: unknown text goes to the shadow when enabled", async () => {
    const rig = new ChatRig({}, { shadow: { enabled: true } });
    rig.say("/dance");
    rig.say("what is up");
    rig.say("/status");
    await rig.run();
    expect(rig.shadowQueue()).toBe(2);
    expect((await rig.chat.shadowSource().updates(0)).map((u) => u.text)).toEqual(["/dance", "what is up"]);
    expect(rig.sent()).toHaveLength(1);
    rig.db.run(
      "INSERT INTO shadow_turns (update_id, at, role, text, state) VALUES (1, 0, 'owner', '/dance', 'done')",
    );
    expect(await rig.chat.shadowSource().updates(0)).toHaveLength(1);
  });

  test("telegram: slash commands accept the bot suffix", async () => {
    const rig = new ChatRig();
    rig.say("/status@towercab_bot");
    rig.say("/Queue@towercab_bot");
    await rig.run();
    expect(rig.sent().map((s) => s.text)).toEqual([
      "Nothing is running and nothing needs you.",
      "The queue is empty.",
    ]);
  });
});
