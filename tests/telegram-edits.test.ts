import { describe, expect, test } from "vitest";
import { KEEP_SECONDS } from "../src/outbox.ts";
import { ChatRig } from "./helpers/telegram.ts";

async function started(over: Parameters<ChatRig["wait"]>[1] = {}, rig = new ChatRig()) {
  const w = rig.wait("i-1", over);
  await rig.run();
  return { rig, w };
}

describe("telegram: a handled wait edits its message", () => {
  test("telegram: a merge on GitHub edits the message", async () => {
    const { rig, w } = await started();
    rig.leave(w.id, "code_merged", "owner");
    await rig.run();
    expect(rig.edits()).toEqual([
      { message: 100, text: "Review and merge the code\n✅ merged by you on GitHub", keyboard: [] },
    ]);
    const other = new ChatRig();
    const o = other.wait("i-2");
    await other.run();
    other.leave(o.id, "code_merged", "towercab[bot]");
    await other.run();
    expect(other.edits()[0]!.text).toBe("Review and merge the code\n✅ merged");
  });

  test("telegram: a button press edits the message", async () => {
    const { rig, msg } = await started().then(({ rig, w }) => ({ rig, w, msg: rig.sent()[0]! }));
    rig.press(rig.data(msg, "Merge"), 100);
    await rig.run();
    const yes = (rig.edits()[0]!.keyboard as { callback_data: string }[][]).flat()[0]!.callback_data;
    rig.press(yes, 100);
    await rig.run();
    expect(rig.edits().at(-1)).toEqual({
      message: 100,
      text: "Review and merge the code\n✅ merged by you",
      keyboard: [],
    });
    expect(rig.sent()).toHaveLength(1);
    expect(rig.answers().at(-1)).toBe("merge done");
  });

  test("telegram: an answer in the page edits the message", async () => {
    const { rig, w } = await started({ question: true });
    rig.leave(w.id, "answered");
    await rig.run();
    expect(rig.edits().map((e) => e.text)).toEqual(["Review and merge the code\n✅ answered by you"]);
    const d = new ChatRig();
    const x = d.wait("i-3");
    await d.run();
    d.leave(x.id, "intent_removed");
    await d.run();
    expect(d.edits()[0]!.text).toContain("🗑 dropped by you");
    const r = new ChatRig();
    const y = r.wait("i-4");
    await r.run();
    r.leave(y.id, "retry_fresh");
    await r.run();
    expect(r.edits()[0]!.text).toContain("↩️ started over by you");
  });

  test("telegram: an ended wait is edited not resent", async () => {
    const { rig, w } = await started();
    rig.leave(w.id, "ok");
    await rig.run();
    await rig.run();
    await rig.run();
    expect(rig.sent()).toHaveLength(1);
    expect(rig.edits()).toHaveLength(1);
    expect(rig.edits()[0]!.text).toBe("Review and merge the code\n✅ no longer needed");
  });

  test("telegram: an edit that Telegram refuses is dropped", async () => {
    const { rig, w } = await started();
    rig.refuseEdits = true;
    rig.leave(w.id, "code_merged", "owner");
    await rig.run();
    const row = rig.db.all<{ sent_at: number; tries: number }>(
      "SELECT sent_at, tries FROM outbox WHERE kind = 'edit'",
    );
    expect(row).toEqual([{ sent_at: 0, tries: 0 }]);
    rig.refuseEdits = false;
    rig.wait("i-2");
    await rig.run();
    expect(rig.sent()).toHaveLength(2);
    expect(rig.logs.filter((l) => l.includes("token"))).toEqual([]);
  });
});

describe("telegram: one message per wait", () => {
  test("telegram: a changed wait edits its message", async () => {
    const { rig } = await started({ question: true });
    rig.views[0]!.why = "A different reason now.";
    await rig.run();
    expect(rig.edits()).toHaveLength(1);
    expect(rig.edits()[0]!.text).toContain("A different reason now.");
    await rig.run();
    expect(rig.edits()).toHaveLength(1);
    expect(rig.sent()).toHaveLength(1);
  });

  test("telegram: a new wait on the same intent is a new message", async () => {
    const { rig, w } = await started();
    rig.leave(w.id, "answered");
    rig.db.run("UPDATE missions SET stage = 'done' WHERE id = ?", w.id);
    rig.wait("i-1", {}, "review and merge PR");
    await rig.run();
    expect(rig.sent()).toHaveLength(2);
    expect(rig.edits()).toHaveLength(1);
  });
});

describe("telegram: short, plain, with a link", () => {
  test("telegram: messages are short and have a link", async () => {
    const { rig } = await started(
      { why: "word ".repeat(400), question: true },
      new ChatRig({ ui_url: "https://tc.example" }),
    );
    const lines = rig.sent()[0]!.text.split("\n");
    const link = lines.pop()!;
    expect(link).toBe("https://tc.example/?intent=i-1");
    expect(lines.join("\n").length).toBeLessThanOrEqual(600);
    expect(rig.sent()[0]!.text).not.toMatch(/\bapproval:|stage|spec_ids/);
  });

  test("telegram: no link without a page address or PR", async () => {
    const { rig } = await started({ pr: null });
    expect(rig.sent()[0]!.text).not.toContain("http");
  });

  test("telegram: a message links to its card", async () => {
    const { rig } = await started({}, new ChatRig({ ui_url: "https://tc.example/" }));
    expect(rig.sent()[0]!.text.split("\n").at(-1)).toBe("https://tc.example/?intent=i-1");
    expect(rig.requests.find((r) => r.method === "sendMessage")!.body.disable_web_page_preview).toBe(true);
  });

  test("telegram: the link falls back to the PR", async () => {
    const { rig } = await started();
    expect(rig.sent()[0]!.text.split("\n").at(-1)).toBe("https://github.com/owner/web/pull/7");
  });
});

describe("telegram: the outbox keeps what it sent", () => {
  test("telegram: a sent message records its id", async () => {
    const { rig, w } = await started();
    const row = rig.db.get<{
      tg_message_id: number;
      kind: string;
      intent: string;
      wait: string;
      sent_at: number;
    }>("SELECT * FROM outbox WHERE key = ?", w.key)!;
    expect(row).toMatchObject({ tg_message_id: 100, kind: "wait", intent: "i-1", wait: `${w.id}.0` });
    expect(row.sent_at).toBeGreaterThan(0);
  });

  test("telegram: edits are sent in order and retried", async () => {
    const { rig, w } = await started();
    rig.leave(w.id, "code_merged", "owner");
    rig.db.run(
      "INSERT INTO outbox (key, mission, text, created, kind, target) VALUES ('e2', NULL, 'second', ?, 'edit', '100')",
      rig.clock.now() + 50,
    );
    rig.failApi = true;
    await rig.run();
    expect(
      rig.db.all<{ tries: number }>("SELECT tries FROM outbox WHERE kind = 'edit' ORDER BY created")[0]!
        .tries,
    ).toBe(1);
    rig.failApi = false;
    rig.clock.advance(30);
    await rig.run();
    await rig.run();
    expect(
      rig
        .edits()
        .map((e) => e.text)
        .slice(-2),
    ).toEqual(["Review and merge the code\n✅ merged by you on GitHub", "second"]);
  });

  test("telegram: a press is answered before other rows", async () => {
    const { rig } = await started();
    rig.db.run("INSERT INTO outbox (key, mission, text, created) VALUES ('old', NULL, 'older notice', 1)");
    rig.press("zzz", 100);
    await rig.chat.pass();
    rig.requests.length = 0;
    await rig.deliver();
    expect(rig.requests.map((r) => r.method)).toEqual(["answerCallbackQuery", "sendMessage"]);
  });

  test("telegram: old rows are removed", async () => {
    const { rig } = await started();
    const old = rig.clock.now() - KEEP_SECONDS - 10;
    rig.db.run(
      "INSERT INTO outbox (key, mission, text, created, sent_at, kind) VALUES ('i', NULL, 'x', ?, ?, 'info')",
      old,
      old,
    );
    rig.db.run(
      "INSERT INTO outbox (key, mission, text, created, sent_at, kind, tg_message_id, ended_at, intent, wait) VALUES ('ended', NULL, 'x', ?, ?, 'wait', 7, ?, 'i-9', '9.0')",
      old,
      old,
      old,
    );
    rig.db.run(
      "INSERT INTO outbox (key, mission, text, created, sent_at, kind, tg_message_id, intent, wait) VALUES ('standing', NULL, 'x', ?, ?, 'wait', 8, 'i-8', '8.0')",
      old,
      old,
    );
    await rig.deliver();
    expect(
      rig.db
        .all<{ key: string }>("SELECT key FROM outbox WHERE key IN ('i', 'ended', 'standing')")
        .map((r) => r.key),
    ).toEqual(["standing"]);
  });
});
