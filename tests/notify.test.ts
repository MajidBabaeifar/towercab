// LOOP-146: Telegram and every webhook get every outbox row, each on its own.

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { Db, MIGRATIONS } from "../src/db.ts";
import { sendWebhooks } from "../src/notify.ts";
import { sendDue } from "../src/outbox.ts";
import { addRow, fakeHttp, sentTo, webhook } from "./helpers/notify.ts";
import { tempDir, testConfig, testDb } from "./helpers/world.ts";

const never = () => false;

function telegram() {
  const sent: string[] = [];
  return {
    sent,
    sender: {
      async send(text: string) {
        sent.push(text);
      },
    },
  };
}

describe("notify", () => {
  test("notify: telegram only keeps working unchanged", async () => {
    const db = testDb();
    const key = addRow(db, "hello", 1);
    const tg = telegram();
    expect(await sendDue(db, tg.sender, 10, never)).toEqual({ sent: 1, dropped: 0, failed: null });
    expect(tg.sent).toEqual(["hello"]);
    expect(db.get<{ sent_at: number }>("SELECT sent_at FROM outbox WHERE key = ?", key)?.sent_at).toBe(10);
    expect(sentTo(db, "telegram")).toEqual([key]);
    // No webhook: nothing else is recorded and nothing is sent again.
    expect(await sendWebhooks(db, [], 11, never)).toEqual({ sent: 0, dropped: 0, failed: {} });
    expect(await sendDue(db, tg.sender, 12, never)).toEqual({ sent: 0, dropped: 0, failed: null });
    expect(db.all("SELECT * FROM outbox_sent WHERE dest != 'telegram'")).toEqual([]);
  });

  test("notify: no destination sends nothing", async () => {
    const db = testDb();
    addRow(db, "hello", 1);
    expect(await sendWebhooks(db, [], 10, never)).toEqual({ sent: 0, dropped: 0, failed: {} });
    expect(db.all("SELECT * FROM outbox WHERE sent_at IS NOT NULL")).toEqual([]);
    expect(db.all("SELECT * FROM outbox_sent")).toEqual([]);
  });

  test("notify: telegram and two webhooks each get every row", async () => {
    const db = testDb();
    const tg = telegram();
    const a = fakeHttp();
    const b = fakeHttp();
    const hooks = [
      webhook(db, a.http, { name: "a", detail: "full" }),
      webhook(db, b.http, { name: "b", detail: "full" }),
    ];
    await sendWebhooks(db, hooks, 1, never); // both webhooks appear
    const k1 = addRow(db, "first", 2);
    const k2 = addRow(db, "second", 3);
    await sendDue(db, tg.sender, 5, never);
    const r = await sendWebhooks(db, hooks, 5, never);
    expect(r.sent).toBe(4);
    expect(tg.sent).toEqual(["first", "second"]);
    for (const h of [a, b]) {
      expect(h.requests.map((q) => JSON.parse(q.body!).text)).toEqual(["first", "second"]);
    }
    for (const dest of ["telegram", "webhook:a", "webhook:b"]) expect(sentTo(db, dest)).toEqual([k1, k2]);
    // Never again.
    expect((await sendWebhooks(db, hooks, 9, never)).sent).toBe(0);
  });

  test("notify: a failing webhook does not delay the others", async () => {
    const db = testDb();
    const bad = fakeHttp();
    const good = fakeHttp();
    bad.queue.push({ status: 500, text: "" });
    const hooks = [webhook(db, bad.http, { name: "bad" }), webhook(db, good.http, { name: "good" })];
    await sendWebhooks(db, hooks, 1, never);
    const k = addRow(db, "x", 2);
    const r = await sendWebhooks(db, hooks, 5, never);
    expect(r.failed).toEqual({ bad: "webhook bad: HTTP 500" });
    expect(r.sent).toBe(1);
    expect(sentTo(db, "webhook:good")).toEqual([k]);
    expect(sentTo(db, "webhook:bad")).toEqual([]);
    // The good one sends the next row at once; the bad one is held by its own backoff.
    addRow(db, "y", 6);
    await sendWebhooks(db, hooks, 6, never);
    expect(good.requests).toHaveLength(2);
    expect(bad.requests).toHaveLength(1);
  });

  test("notify: a row stays queued until every destination has it", async () => {
    const db = testDb();
    const tg = telegram();
    const h = fakeHttp();
    h.queue.push({ status: 503, text: "" });
    const hook = webhook(db, h.http, { name: "team" });
    await sendWebhooks(db, [hook], 1, never);
    const k = addRow(db, "wait", 2);
    await sendDue(db, tg.sender, 5, never);
    await sendWebhooks(db, [hook], 5, never);
    expect(sentTo(db, "telegram")).toEqual([k]);
    expect(sentTo(db, "webhook:team")).toEqual([]);
    expect(
      db.get("SELECT * FROM outbox_sent WHERE dest = 'webhook:team' AND tries = 1 AND next_try = 35"),
    ).toBeTruthy();
    // Not due: nothing. Due: sent.
    expect((await sendWebhooks(db, [hook], 34, never)).sent).toBe(0);
    expect((await sendWebhooks(db, [hook], 35, never)).sent).toBe(1);
    expect(sentTo(db, "webhook:team")).toEqual([k]);
  });

  test("notify: a new webhook skips older rows", async () => {
    const db = testDb();
    addRow(db, "old", 1);
    const h = fakeHttp();
    const hook = webhook(db, h.http, { detail: "full" });
    // The first pass that sees it is at 10; the row written at 1 is older.
    await sendWebhooks(db, [hook], 10, never);
    const k = addRow(db, "new", 11);
    await sendWebhooks(db, [hook], 12, never);
    expect(h.requests.map((q) => JSON.parse(q.body!).text)).toEqual(["new"]);
    expect(sentTo(db, "webhook:team")).toEqual([k]);
  });

  test("notify: a re-added webhook keeps its first time", async () => {
    const db = testDb();
    const h = fakeHttp();
    await sendWebhooks(db, [webhook(db, h.http, { detail: "full" })], 10, never);
    // Removed from the config; a row is written meanwhile; the webhook comes back under the same name.
    addRow(db, "while away", 20);
    await sendWebhooks(db, [], 30, never);
    await sendWebhooks(db, [webhook(db, h.http, { detail: "full" })], 40, never);
    expect(db.meta("notify.added.webhook:team")).toBe("10");
    expect(h.requests.map((q) => JSON.parse(q.body!).text)).toEqual(["while away"]);
  });

  /** A database as it was at version 12 (before `outbox_sent`), reopened by this Towercab. */
  function upgraded(seed: (db: Db) => void): Db {
    const path = join(tempDir("tc-db-"), "towercab.db");
    const old = new Db(path);
    old.sql.exec("DROP TABLE outbox_sent; PRAGMA user_version = 12");
    seed(old);
    old.sql.close();
    return new Db(path);
  }

  test("notify: upgrade marks rows telegram sent as sent", () => {
    let sent = "";
    let dropped = "";
    const db = upgraded((o) => {
      sent = addRow(o, "sent", 1);
      dropped = addRow(o, "dropped", 2);
      o.run("UPDATE outbox SET sent_at = 5 WHERE key = ?", sent);
      o.run("UPDATE outbox SET sent_at = 0 WHERE key = ?", dropped);
    });
    expect(db.version()).toBe(MIGRATIONS.length);
    expect(db.all("SELECT key, dest, sent_at FROM outbox_sent ORDER BY sent_at DESC")).toEqual([
      { key: sent, dest: "telegram", sent_at: 5 },
      { key: dropped, dest: "telegram", sent_at: 0 },
    ]);
  });

  test("notify: upgrade keeps rows telegram has not sent", async () => {
    let waiting = "";
    let retrying = "";
    const db = upgraded((o) => {
      waiting = addRow(o, "waiting", 1);
      retrying = addRow(o, "retrying", 2);
      o.run("UPDATE outbox SET tries = 2, next_try = 90 WHERE key = ?", retrying);
    });
    // Only the retry state is copied; neither row counts as sent.
    expect(db.all("SELECT key, sent_at, tries, next_try FROM outbox_sent")).toEqual([
      { key: retrying, sent_at: null, tries: 2, next_try: 90 },
    ]);
    const tg = telegram();
    await sendDue(db, tg.sender, 100, never);
    expect(tg.sent).toEqual(["waiting", "retrying"]);
    expect(sentTo(db, "telegram").sort()).toEqual([retrying, waiting].sort());
  });

  test("notify: the seed is run once", () => {
    let sent = "";
    const db = upgraded((o) => {
      sent = addRow(o, "sent", 1);
      o.run("UPDATE outbox SET sent_at = 5 WHERE key = ?", sent);
    });
    const before = db.all("SELECT * FROM outbox_sent");
    expect(before).toHaveLength(1);
    // Running the migration again (a re-upgrade after a rollback) changes nothing, even after a later send.
    db.run("UPDATE outbox_sent SET sent_at = 7 WHERE key = ?", sent);
    db.sql.exec(MIGRATIONS[12]!);
    expect(db.all("SELECT sent_at FROM outbox_sent")).toEqual([{ sent_at: 7 }]);
  });

  test("notify: edit rows go to telegram only", async () => {
    const db = testDb();
    const h = fakeHttp();
    const hook = webhook(db, h.http, { detail: "full" });
    await sendWebhooks(db, [hook], 1, never);
    addRow(db, "edited text", 2, "edit");
    addRow(db, "pressed", 3, "answer");
    const info = addRow(db, "message", 4);
    await sendWebhooks(db, [hook], 5, never);
    expect(h.requests.map((q) => JSON.parse(q.body!).text)).toEqual(["message"]);
    expect(sentTo(db, "webhook:team")).toEqual([info]);
  });

  test("notify: a webhook keeps the telegram reading", () => {
    const hooks = [{ name: "team", url_file: "/tmp/hook-url" }];
    const config = testConfig({
      telegram: { bot_token: "t", chat_id: 42 },
      shadow: { enabled: true },
      notify: { webhook: hooks },
    });
    expect(config.telegram).toMatchObject({ botToken: "t", chatId: "42" });
    expect(config.shadow.enabled).toBe(true);
    expect(config.notify.webhooks.map((w) => w.name)).toEqual(["team"]);
    // The shadow still needs Telegram: a webhook does not stand in for it.
    expect(() => testConfig({ shadow: { enabled: true }, notify: { webhook: hooks } })).toThrow(
      /shadow\.enabled needs a \[telegram\] section/,
    );
    // Without `[notify]` nothing changes.
    expect(testConfig({ telegram: { bot_token: "t", chat_id: 42 } }).notify.webhooks).toEqual([]);
  });
});
