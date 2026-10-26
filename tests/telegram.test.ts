import { describe, expect, test } from "vitest";
import type { HttpRequest, HttpResponse } from "../src/github/app.ts";
import { type OutboxRow, sendDue } from "../src/outbox.ts";
import { Telegram } from "../src/telegram.ts";
import { testDb } from "./helpers/world.ts";

const TOKEN = "123456:secret-token";
const config = { botToken: TOKEN, chatId: "42", apiBase: "https://tg.test" };

/** The Bot API: answers from a queue (then 200 ok), recording each request. */
function fakeApi() {
  const requests: HttpRequest[] = [];
  const queue: (HttpResponse | Error)[] = [];
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { status: 200, text: '{"ok":true,"result":{}}' };
  };
  return { requests, queue, http };
}

const ok500 = (): HttpResponse => ({
  status: 500,
  text: '{"ok":false,"description":"Internal Server Error"}',
});

function rows(db: ReturnType<typeof testDb>) {
  return db.all<OutboxRow>("SELECT * FROM outbox ORDER BY created, rowid");
}

describe("telegram", () => {
  test("telegram: retries until sent", async () => {
    const db = testDb();
    db.run("INSERT INTO outbox (key, mission, text, created) VALUES ('a', NULL, 'first', 1)");
    db.run("INSERT INTO outbox (key, mission, text, created) VALUES ('b', NULL, ?, 2)", "x".repeat(5000));
    const api = fakeApi();
    api.queue.push(ok500(), ok500(), ok500());
    const tg = new Telegram(config, api.http, () => {});

    // Each failure backs off 30, 60, 120 s; the row behind waits (oldest first).
    let t = 1000;
    for (const [tries, after] of [
      [1, 30],
      [2, 60],
      [3, 120],
    ] as const) {
      const r = await sendDue(db, tg, t);
      expect(r).toMatchObject({ sent: 0, dropped: 0 });
      expect(r.failed).toMatch(/HTTP 500: Internal Server Error/);
      expect(rows(db)[0]).toMatchObject({ tries, next_try: t + after, sent_at: null });
      t += after;
    }
    // Not due yet: nothing is tried, nothing behind it either.
    const before = api.requests.length;
    expect(await sendDue(db, tg, t - 1)).toEqual({ sent: 0, dropped: 0, failed: null });
    expect(api.requests.length).toBe(before);
    // Due: sent, then the one behind it; never again.
    expect(await sendDue(db, tg, t)).toEqual({ sent: 2, dropped: 0, failed: null });
    expect(rows(db).map((r) => r.sent_at)).toEqual([t, t]);
    expect(await sendDue(db, tg, t + 60)).toEqual({ sent: 0, dropped: 0, failed: null });
    expect(api.requests).toHaveLength(5);

    const req = api.requests[3]!;
    expect([req.method, req.url, req.timeoutMs]).toEqual([
      "POST",
      `https://tg.test/bot${TOKEN}/sendMessage`,
      10_000,
    ]);
    expect(JSON.parse(req.body!)).toEqual({ chat_id: "42", text: "first", disable_web_page_preview: true });
    const long = JSON.parse(api.requests[4]!.body!).text as string;
    expect([...long]).toHaveLength(4000);
    expect(long.endsWith("…")).toBe(true);
    // The backoff stops growing at 300 s.
    db.run("INSERT INTO outbox (key, mission, text, created, tries) VALUES ('c', NULL, 'z', 3, 6)");
    api.queue.push(ok500());
    await sendDue(db, tg, 5000);
    expect(rows(db)[2]).toMatchObject({ tries: 7, next_try: 5300 });
  });

  test("telegram: failures never raise", async () => {
    const db = testDb();
    db.run("INSERT INTO outbox (key, mission, text, created) VALUES ('a', NULL, 'hi', 1)");
    const api = fakeApi();
    const logged: string[] = [];
    const tg = new Telegram(config, api.http, (l) => logged.push(l));

    // Network down (an error naming the URL with the token), HTTP 200 without ok, a proxy page.
    api.queue.push(
      new Error(`connect ECONNREFUSED https://tg.test/bot${TOKEN}/sendMessage`),
      { status: 200, text: '{"ok":false,"description":"Bad Request: chat not found"}' },
      { status: 502, text: "<html>Bad Gateway</html>" },
    );
    const fails: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await sendDue(db, tg, 1000 + i * 1000);
      expect(r.sent).toBe(0);
      fails.push(r.failed!);
    }
    expect(fails).toEqual([
      "telegram sendMessage: connect ECONNREFUSED https://tg.test/bot<token>/sendMessage",
      "telegram sendMessage: HTTP 200: Bad Request: chat not found",
      "telegram sendMessage: HTTP 502: ok is not true",
    ]);
    // Logged once for the outage, never with the token.
    expect(logged).toEqual([fails[0]]);
    expect(JSON.stringify([fails, logged, rows(db)])).not.toContain(TOKEN);
    // Back up: sent; a new outage is logged again.
    expect((await sendDue(db, tg, 5000)).sent).toBe(1);
    api.queue.push(new Error("ETIMEDOUT"));
    await expect(tg.send("x")).rejects.toThrow("telegram sendMessage: ETIMEDOUT");
    expect(logged).toHaveLength(2);
  });
});
