// LOOP-147..149: what a webhook sends, to where, and how it fails.

import { chmodSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { sendWebhooks } from "../src/notify.ts";
import {
  addRow,
  fakeHttp,
  hookConfig,
  PAGE,
  SECRET_URL,
  sentTo,
  urlFile,
  waiters,
  webhook,
} from "./helpers/notify.ts";
import { testConfig, testDb } from "./helpers/world.ts";

const never = () => false;

/** One webhook that has already appeared (so rows written from time 2 on are its). */
async function ready(o: Parameters<typeof webhook>[2] = {}, log: (l: string) => void = () => {}) {
  const db = testDb();
  const h = fakeHttp();
  const hook = webhook(db, h.http, { detail: "full", ...o }, log);
  await sendWebhooks(db, [hook], 1, never);
  return { db, h, hook };
}

const bodies = (h: ReturnType<typeof fakeHttp>) => h.requests.map((q) => JSON.parse(q.body!));

describe("webhook delivery (LOOP-147)", () => {
  test("webhook: names must be unique", () => {
    const t = (name?: string) => ({ ...(name === undefined ? {} : { name }), url_file: "/tmp/u" });
    expect(() => testConfig({ notify: { webhook: [t("a"), t("a")] } })).toThrow(
      /notify\.webhook name a is used twice/,
    );
    expect(() => testConfig({ notify: { webhook: [t()] } })).toThrow(/notify\.webhook name must be set/);
    expect(() => testConfig({ notify: { webhook: [t("Bad Name")] } })).toThrow(
      /notify\.webhook name must be set/,
    );
    expect(testConfig({ notify: { webhook: [t("a"), t("b_2")] } }).notify.webhooks).toHaveLength(2);
  });

  test("webhook: posts json with the default body", async () => {
    const { db, h } = await ready();
    addRow(db, "something waits", 2);
    await sendWebhooks(db, [webhook(db, h.http, { detail: "full" })], 3, never);
    const req = h.requests[0]!;
    expect([req.method, req.url, req.timeoutMs, req.redirect]).toEqual([
      "POST",
      SECRET_URL,
      10_000,
      "manual",
    ]);
    expect(req.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(req.body!)).toEqual({ text: "something waits" });
  });

  test("webhook: retries until sent", async () => {
    const { db, h, hook } = await ready();
    h.queue.push({ status: 500, text: "" }, new Error("ETIMEDOUT"), { status: 502, text: "" });
    const key = addRow(db, "x", 2);
    let t = 10;
    for (const [tries, after] of [
      [1, 30],
      [2, 60],
      [3, 120],
    ] as const) {
      const r = await sendWebhooks(db, [hook], t, never);
      expect(r.sent).toBe(0);
      expect(
        db.get(
          "SELECT * FROM outbox_sent WHERE key = ? AND dest = 'webhook:team' AND tries = ? AND next_try = ?",
          key,
          tries,
          t + after,
        ),
      ).toBeTruthy();
      t += after;
    }
    // Not due one second early; due on time; never again.
    const before = h.requests.length;
    await sendWebhooks(db, [hook], t - 1, never);
    expect(h.requests.length).toBe(before);
    expect((await sendWebhooks(db, [hook], t, never)).sent).toBe(1);
    expect(sentTo(db, "webhook:team")).toEqual([key]);
    expect((await sendWebhooks(db, [hook], t + 600, never)).sent).toBe(0);
    // The backoff stops growing at 300 s.
    db.run("INSERT INTO outbox_sent (key, dest, tries) VALUES ('z', 'webhook:team', 6)");
    addRow(db, "z", 3, "info", "z");
    h.queue.push({ status: 500, text: "" });
    await sendWebhooks(db, [hook], 5000, never);
    expect(
      db.get(
        "SELECT * FROM outbox_sent WHERE key = 'z' AND dest = 'webhook:team' AND tries = 7 AND next_try = 5300",
      ),
    ).toBeTruthy();
  });

  test("webhook: failures never raise", async () => {
    const { db, h, hook } = await ready();
    h.queue.push(
      new Error("ECONNREFUSED"),
      { status: 404, text: `no such hook ${SECRET_URL}` },
      { status: 200, text: "ok" },
    );
    addRow(db, "x", 2);
    const failures: string[] = [];
    for (const t of [10, 100, 1000]) {
      const r = await sendWebhooks(db, [hook], t, never);
      if (r.failed.team) failures.push(r.failed.team);
    }
    expect(failures).toEqual(["webhook team: ECONNREFUSED", "webhook team: HTTP 404"]);
  });

  test("webhook: oldest first and stops at the first failure", async () => {
    const { db, h, hook } = await ready();
    h.queue.push({ status: 500, text: "" });
    const a = addRow(db, "first", 2);
    const b = addRow(db, "second", 3);
    await sendWebhooks(db, [hook], 10, never);
    expect(bodies(h)).toEqual([{ text: "first" }]);
    expect(sentTo(db, "webhook:team")).toEqual([]);
    await sendWebhooks(db, [hook], 40, never);
    expect(bodies(h)).toEqual([{ text: "first" }, { text: "first" }, { text: "second" }]);
    expect(sentTo(db, "webhook:team")).toEqual([a, b]);
  });

  test("webhook: one log line per outage", async () => {
    const logged: string[] = [];
    const { db, h, hook } = await ready({}, (l) => logged.push(l));
    h.queue.push({ status: 500, text: "" }, { status: 500, text: "" }, new Error("ETIMEDOUT"));
    addRow(db, "x", 2);
    await sendWebhooks(db, [hook], 10, never);
    await sendWebhooks(db, [hook], 100, never);
    await sendWebhooks(db, [hook], 1000, never);
    expect(logged).toEqual(["webhook team: HTTP 500"]);
    // Back up: one line says so; a later outage is logged again.
    await sendWebhooks(db, [hook], 2000, never);
    expect(logged).toEqual(["webhook team: HTTP 500", "webhook team: sending again"]);
    h.queue.push({ status: 503, text: "" });
    addRow(db, "y", 3);
    await sendWebhooks(db, [hook], 3000, never);
    expect(logged).toHaveLength(3);
  });

  test("webhook: the url never appears in a log line", async () => {
    const logged: string[] = [];
    const { db, h, hook } = await ready({}, (l) => logged.push(l));
    const key = addRow(db, "x", 2);
    h.queue.push(
      new Error(`fetch failed: ${SECRET_URL}`),
      { status: 302, text: SECRET_URL },
      { status: 200, text: "ok" },
    );
    const failed: string[] = [];
    for (const t of [10, 100]) failed.push((await sendWebhooks(db, [hook], t, never)).failed.team!);
    await sendWebhooks(db, [hook], 1000, never);
    const everything = JSON.stringify([
      logged,
      failed,
      db.all("SELECT * FROM outbox_sent"),
      db.all("SELECT * FROM outbox"),
      db.all("SELECT * FROM meta"),
    ]);
    expect(everything).not.toContain("T0K3N");
    expect(everything).not.toContain("chat.example.com");
    expect(failed).toEqual(["webhook team: network error", "webhook team: redirect (HTTP 302)"]);
    expect(sentTo(db, "webhook:team")).toEqual([key]);
  });

  test("webhook: a redirect is a failure", async () => {
    const { db, h, hook } = await ready();
    h.queue.push({ status: 307, text: "" });
    addRow(db, "x", 2);
    const r = await sendWebhooks(db, [hook], 10, never);
    expect(r.failed.team).toBe("webhook team: redirect (HTTP 307)");
    expect(h.requests[0]!.redirect).toBe("manual");
    expect(sentTo(db, "webhook:team")).toEqual([]);
  });

  test("webhook: a loose url file is refused", async () => {
    const file = urlFile(SECRET_URL, 0o644);
    const { db, h, hook } = await ready({ urlFile: file });
    addRow(db, "x", 2);
    const r = await sendWebhooks(db, [hook], 10, never);
    expect(r.failed.team).toBe("webhook team: url_file is readable by group or others: chmod 600 it");
    expect(h.requests).toEqual([]);
    // chmod 600 and it works at the next backoff; a missing file fails with the reason, not the path's content.
    chmodSync(file, 0o600);
    expect((await sendWebhooks(db, [hook], 100, never)).sent).toBe(1);
    const missing = await ready({ urlFile: `${file}.gone` });
    addRow(missing.db, "x", 2);
    expect((await sendWebhooks(missing.db, [missing.hook], 10, never)).failed.team).toBe(
      "webhook team: url_file does not exist",
    );
  });

  test("webhook: https is accepted", async () => {
    for (const url of [
      "https://chat.example.com/hook",
      "https://10.0.0.5:8443/hook",
      "https://localhost/hook",
    ]) {
      const { db, h, hook } = await ready({ urlFile: urlFile(url) });
      addRow(db, "x", 2);
      expect((await sendWebhooks(db, [hook], 10, never)).sent, url).toBe(1);
      expect(h.requests[0]!.url).toBe(url);
    }
  });

  test("webhook: http is accepted for localhost and private addresses", async () => {
    const urls = [
      "http://localhost:8065/hooks/x",
      "http://127.0.0.1/hooks/x",
      "http://127.8.8.8/hooks/x",
      "http://[::1]:8065/hooks/x",
      "http://10.1.2.3/hooks/x",
      "http://172.16.0.1/hooks/x",
      "http://172.31.255.254/hooks/x",
      "http://192.168.1.20:8065/hooks/x",
      "http://chat.local/hooks/x",
      "http://Mattermost.LOCAL:8065/hooks/x",
    ];
    for (const url of urls) {
      const { db, hook } = await ready({ urlFile: urlFile(url) });
      addRow(db, "x", 2);
      expect((await sendWebhooks(db, [hook], 10, never)).sent, url).toBe(1);
    }
  });

  test("webhook: http to a public host is refused", async () => {
    for (const url of [
      "http://chat.example.com/hook",
      "http://8.8.8.8/hook",
      "http://172.32.0.1/hook",
      "http://172.15.0.1/hook",
      "http://192.169.0.1/hook",
      "http://11.0.0.1/hook",
      "http://10.0.0.1.example.com/hook",
      "http://localhost.example.com/hook",
    ]) {
      const { db, h, hook } = await ready({ urlFile: urlFile(url) });
      addRow(db, "x", 2);
      const r = await sendWebhooks(db, [hook], 10, never);
      expect(r.failed.team, url).toBe("webhook team: url_file: http is only allowed for local addresses");
      expect(h.requests).toEqual([]);
    }
  });

  test("webhook: a name that resolves privately still needs https", async () => {
    // The host is judged as written: nothing is looked up, so a public name never gets the http exception.
    const { db, h, hook } = await ready({ urlFile: urlFile("http://internal.corp.example.com/hook") });
    addRow(db, "x", 2);
    const r = await sendWebhooks(db, [hook], 10, never);
    expect(r.failed.team).toBe("webhook team: url_file: http is only allowed for local addresses");
    expect(h.requests).toEqual([]);
  });

  test("webhook: other schemes are refused", async () => {
    for (const url of [
      "ftp://chat.example.com/hook",
      "file:///etc/passwd",
      "chat.example.com/hook",
      "javascript:alert(1)",
    ]) {
      const { db, h, hook } = await ready({ urlFile: urlFile(url) });
      addRow(db, "x", 2);
      const r = await sendWebhooks(db, [hook], 10, never);
      expect(r.failed.team, url).toBe("webhook team: url_file: not an https url");
      expect(h.requests).toEqual([]);
    }
  });

  test("webhook: a refusal never shows the url", async () => {
    const logged: string[] = [];
    const { db, hook } = await ready({ urlFile: urlFile("http://hooks.example.com/services/T0K3N") }, (l) =>
      logged.push(l),
    );
    addRow(db, "x", 2);
    const r = await sendWebhooks(db, [hook], 10, never);
    expect(JSON.stringify([r, logged])).not.toMatch(/T0K3N|hooks\.example\.com/);
    expect(logged).toHaveLength(1);
  });

  test("webhook: the url is read at each send", async () => {
    const file = urlFile("https://one.example.com/hook");
    const { db, h, hook } = await ready({ urlFile: file });
    addRow(db, "a", 2);
    await sendWebhooks(db, [hook], 10, never);
    // The owner replaces the URL in the file; the next send uses it without a restart.
    writeFileSync(file, "https://two.example.com/hook\n");
    addRow(db, "b", 11);
    await sendWebhooks(db, [hook], 12, never);
    expect(h.requests.map((q) => q.url)).toEqual([
      "https://one.example.com/hook",
      "https://two.example.com/hook",
    ]);
  });
});

describe("webhook template (LOOP-148)", () => {
  test("webhook: the default body has only a text field", async () => {
    const { db, h, hook } = await ready();
    addRow(db, "hi", 2);
    await sendWebhooks(db, [hook], 3, never);
    expect(h.requests[0]!.body).toBe('{"text": "hi"}');
  });

  test("webhook: a template fills text and link", async () => {
    const { db, h, hook } = await ready({
      template: '{"channel": "ops", "content": "{text}", "links": ["{link}"]}',
    });
    addRow(db, "hi", 2);
    await sendWebhooks(db, [hook], 3, never);
    expect(bodies(h)).toEqual([{ channel: "ops", content: "hi", links: [PAGE] }]);
  });

  test("webhook: a title with quotes and newlines stays valid json", async () => {
    const { db, h, hook } = await ready({ template: '{"a": {"b": "x {text} y"}}' });
    const nasty = 'Fix "the" login\nline two \\ back\tslash — ünï 🚀 {link}';
    addRow(db, nasty, 2);
    await sendWebhooks(db, [hook], 3, never);
    expect(bodies(h)[0]).toEqual({ a: { b: `x ${nasty} y` } });
  });

  test("webhook: an unknown placeholder stays as written", async () => {
    const { db, h, hook } = await ready({ template: '{"text": "{text}", "who": "{user}", "n": "{1}"}' });
    addRow(db, "hi", 2);
    await sendWebhooks(db, [hook], 3, never);
    expect(bodies(h)).toEqual([{ text: "hi", who: "{user}", n: "{1}" }]);
  });

  test("webhook: an invalid template fails the config", () => {
    const wh = (template: string) => ({ notify: { webhook: [{ name: "t", url_file: "/tmp/u", template }] } });
    expect(() => testConfig(wh('{"text": {text}}'))).toThrow(
      /notify\.webhook\.t\.template has \{text\} outside a JSON string/,
    );
    expect(() => testConfig(wh('{"text": "{text}"'))).toThrow(
      /notify\.webhook\.t\.template is not valid JSON/,
    );
    expect(() => testConfig(wh("text={text}"))).toThrow(/notify\.webhook\.t\.template/);
    expect(testConfig(wh('{"text": "{text}"}')).notify.webhooks[0]!.template).toBe('{"text": "{text}"}');
  });
});

describe("webhook detail (LOOP-149)", () => {
  test("webhook: detail defaults to minimal", async () => {
    const config = testConfig({ notify: { webhook: [{ name: "t", url_file: "/tmp/u" }] } });
    expect(config.notify.webhooks[0]!.detail).toBe("minimal");
    expect(hookConfig().detail).toBe("minimal");
  });

  test("webhook: minimal counts the waits at send time", async () => {
    const { db, h, hook } = await ready({ detail: "minimal" });
    addRow(db, "Ship it (web)\nwhy", 2);
    waiters(db, 2);
    // The count is taken when the message goes out, not when the row was written.
    waiters(db, 1);
    await sendWebhooks(db, [hook], 10, never);
    expect(bodies(h)).toEqual([{ text: `3 things wait for you in Towercab: ${PAGE}` }]);
  });

  test("webhook: minimal with one wait is singular", async () => {
    const { db, h, hook } = await ready({ detail: "minimal" });
    addRow(db, "x", 2);
    waiters(db, 1);
    await sendWebhooks(db, [hook], 10, never);
    expect(bodies(h)).toEqual([{ text: `1 thing waits for you in Towercab: ${PAGE}` }]);
  });

  test("webhook: minimal with no waits says Towercab needs a look", async () => {
    const { db, h, hook } = await ready({ detail: "minimal" });
    addRow(db, "Towercab can't reach GitHub", 2);
    await sendWebhooks(db, [hook], 10, never);
    expect(bodies(h)).toEqual([{ text: `Towercab needs a look: ${PAGE}` }]);
    // With the page off there is no link to give.
    const off = fakeHttp();
    const noLink = webhook(db, off.http, { detail: "minimal" }, () => {}, null);
    addRow(db, "y", 20);
    await sendWebhooks(db, [noLink], 30, never);
    expect(bodies(off)).toEqual([{ text: "Towercab needs a look" }]);
  });

  test("webhook: minimal has no title, repo, reason or id", async () => {
    const { db, h, hook } = await ready({ detail: "minimal" });
    waiters(db, 1);
    const secret =
      "Ship the Acme payroll fix (acme-web)\nthe reviewer found a leak\nhttps://github.com/acme/web/pull/7 261001-0900";
    addRow(db, secret, 2);
    await sendWebhooks(db, [hook], 10, never);
    const sent = JSON.stringify(bodies(h));
    for (const word of ["Acme", "acme-web", "leak", "github.com", "261001", "payroll"])
      expect(sent).not.toContain(word);
  });

  test("webhook: full detail sends the usual text", async () => {
    const { db, h, hook } = await ready({ detail: "full" });
    const text = "Approve the spec\nShip it (web)\nhttps://github.com/me/web/pull/7";
    addRow(db, text, 2);
    waiters(db, 2);
    await sendWebhooks(db, [hook], 10, never);
    expect(bodies(h)).toEqual([{ text }]);
    // Capped at 4000 characters, like Telegram.
    addRow(db, "x".repeat(5000), 11);
    await sendWebhooks(db, [hook], 12, never);
    const long = bodies(h)[1].text as string;
    expect([...long]).toHaveLength(4000);
    expect(long.endsWith("…")).toBe(true);
  });

  test("webhook: each webhook uses its own detail", async () => {
    const db = testDb();
    const a = fakeHttp();
    const b = fakeHttp();
    const hooks = [
      webhook(db, a.http, { name: "a", detail: "minimal" }),
      webhook(db, b.http, { name: "b", detail: "full" }),
    ];
    await sendWebhooks(db, hooks, 1, never);
    waiters(db, 2);
    addRow(db, "Ship it (web)", 2);
    await sendWebhooks(db, hooks, 5, never);
    expect(bodies(a)).toEqual([{ text: `2 things wait for you in Towercab: ${PAGE}` }]);
    expect(bodies(b)).toEqual([{ text: "Ship it (web)" }]);
  });

  test("webhook: an unknown detail fails the config", () => {
    expect(() =>
      testConfig({ notify: { webhook: [{ name: "t", url_file: "/tmp/u", detail: "short" }] } }),
    ).toThrow(/notify\.webhook\.t\.detail must be minimal or full/);
  });
});
