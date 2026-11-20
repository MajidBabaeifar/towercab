import { describe, expect, test } from "vitest";
import { ChatRig } from "./helpers/telegram.ts";

const settle = () => new Promise<void>((r) => setImmediate(r));

describe("telegram: reading the chat", () => {
  test("telegram: updates are read without the shadow", async () => {
    const rig = new ChatRig();
    expect(rig.config.shadow.enabled).toBe(false);
    rig.say("/status");
    await rig.run();
    expect(rig.sent()[0]!.text).toBe("Nothing is running and nothing needs you.");
    const get = rig.requests.find((r) => r.method === "getUpdates")!;
    expect(get.url).toContain("allowed_updates=%5B%22message%22%2C%22callback_query%22%5D");
  });

  test("telegram: an update is stored once before the offset moves", async () => {
    const rig = new ChatRig();
    const u = { id: 5, chat: "42", text: "/status" };
    rig.chat.store([u]);
    expect(rig.db.meta("telegram.offset")).toBe("6");
    expect(rig.db.all("SELECT update_id FROM telegram_updates")).toEqual([{ update_id: 5 }]);
    rig.chat.store([u]);
    expect(rig.db.all("SELECT update_id FROM telegram_updates")).toHaveLength(1);
    expect(rig.db.meta("telegram.offset")).toBe("6");
    // Stored once, handled once, however often it is offered again.
    await rig.run();
    rig.chat.store([u]);
    await rig.run();
    expect(rig.sent().map((x) => x.text)).toEqual(["Nothing is running and nothing needs you."]);
  });

  test("telegram: no telegram config no polling", async () => {
    const rig = new ChatRig({}, {}, { noTelegram: true });
    rig.say("/status");
    await rig.run();
    expect(rig.requests).toEqual([]);
  });

  test("telegram: a crash after a button press does not repeat the action", async () => {
    const rig = new ChatRig();
    rig.wait("i-1");
    await rig.run();
    const msg = rig.sent()[0]!;
    const press = rig.press(rig.data(msg, "Start over"), 100);
    await rig.run();
    expect(rig.actionCalls.filter((c) => c.startsWith("retry"))).toEqual(["retry i-1"]);
    // The same update again (the offset did not move): nothing is repeated.
    rig.chat.store([{ id: press, chat: "42", text: null }]);
    await rig.run();
    expect(rig.actionCalls.filter((c) => c.startsWith("retry"))).toHaveLength(1);
    // A crash between "started" and "finished": the press is answered, never run again.
    rig.db.run(
      "INSERT INTO telegram_updates (update_id, at, data, state) VALUES (77, 0, ?, 'handling')",
      JSON.stringify({
        id: 77,
        chat: "42",
        text: null,
        callback: { id: "cb77", data: rig.data(msg, "Drop"), message: 100 },
      }),
    );
    await rig.run();
    expect(rig.actionCalls.filter((c) => c.startsWith("drop"))).toEqual([]);
    expect(rig.answers().at(-1)).toBe("I can't tell if that went through: check the page.");
    expect(rig.db.all("SELECT state FROM telegram_updates WHERE update_id = 77")).toEqual([
      { state: "done" },
    ]);
  });
});

describe("telegram: the long poll", () => {
  test("telegram: a long poll does not delay a pass", async () => {
    const rig = new ChatRig();
    rig.gated = true;
    rig.chat.start();
    await settle();
    expect(rig.pending).toHaveLength(1);
    expect(rig.requests[0]!.url).toContain("timeout=25");
    rig.say("/queue");
    // The poll is still open; the pass neither waits for it nor asks again.
    await rig.run();
    expect(rig.requests.filter((r) => r.method === "getUpdates")).toHaveLength(1);
    rig.pending.shift()!();
    await settle();
    await settle();
    await rig.run();
    expect(rig.sent()[0]!.text).toBe("The queue is empty.");
    rig.chat.stop();
    rig.pending.shift()?.();
  });

  test("telegram: the poll stops on shutdown and resumes from the offset", async () => {
    const rig = new ChatRig();
    rig.gated = true;
    rig.say("/queue");
    rig.chat.start();
    await settle();
    rig.pending.shift()!();
    await settle();
    await settle();
    expect(rig.db.meta("telegram.offset")).toBe("2");
    expect(rig.pending).toHaveLength(1);
    rig.chat.stop();
    rig.pending.shift()!();
    await settle();
    await settle();
    expect(rig.pending).toHaveLength(0);
    const asked = rig.requests.filter((r) => r.method === "getUpdates").length;
    rig.chat.start();
    await settle();
    expect(rig.requests.filter((r) => r.method === "getUpdates")).toHaveLength(asked + 1);
    expect(rig.requests.at(-1)!.url).toContain("offset=2&");
    rig.chat.stop();
    rig.pending.shift()?.();
  });

  test("telegram: polling continues while paused", async () => {
    const rig = new ChatRig();
    rig.db.setMeta("paused", "1");
    rig.say("/status");
    await rig.run();
    expect(rig.sent()[0]!.text).toContain("Paused");
    expect(rig.requests.some((r) => r.method === "getUpdates")).toBe(true);
  });
});
