// UI-1, UI-4, UI-65: the page's server: localhost only, security, the API, run files.

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { UiActions } from "../../src/ui/actions.ts";
import { startUi, type UiServer } from "../../src/ui/server.ts";
import { redact } from "../../src/ui/state.ts";
import { buildFixture, type Fixture, IDS } from "../../ui/fixture.ts";
import { tempDir, testConfig } from "../helpers/world.ts";
import { call, post } from "./http.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

function dist(): string {
  const d = tempDir("tc-dist-");
  mkdirSync(join(d, "assets"));
  writeFileSync(
    join(d, "index.html"),
    '<!doctype html><html><head><meta name="towercab-token" content="" /><title>Towercab</title><script type="module" src="/assets/app.js"></script></head><body></body></html>',
  );
  writeFileSync(join(d, "assets", "app.js"), "console.log('hi')");
  writeFileSync(join(d, "assets", "app.css"), "body{}");
  return d;
}

async function serve(
  o: { actions?: UiActions | null; distDir?: string; fixture?: Fixture; log?: string[] } = {},
): Promise<{ f: Fixture; ui: UiServer; port: number }> {
  const f = o.fixture ?? buildFixture();
  const ui = startUi({
    port: 0,
    sources: f.sources,
    actions: o.actions === undefined ? f.actions : o.actions,
    distDir: o.distDir ?? dist(),
    log: (l) => o.log?.push(l),
    pollMs: 20,
  });
  cleanup.push(() => f.cleanup());
  cleanup.push(() => ui.stop());
  const port = await ui.ready;
  return { f, ui, port };
}

test("ui: binds localhost only", async () => {
  // A busy port is logged once and retried until it frees up.
  const blocker = createServer();
  await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
  const busy = (blocker.address() as { port: number }).port;
  const log: string[] = [];
  const f = buildFixture();
  cleanup.push(() => f.cleanup());
  const ui = startUi({
    port: busy,
    sources: f.sources,
    actions: null,
    distDir: dist(),
    log: (l) => log.push(l),
    retryMs: 30,
  });
  cleanup.push(() => ui.stop());
  await new Promise((r) => setTimeout(r, 120));
  expect(ui.port()).toBeNull();
  expect(log.filter((l) => l.includes("in use"))).toEqual([
    `ui: port ${busy} is in use; trying again every 0 s`,
  ]);
  await new Promise<void>((r) => blocker.close(() => r()));
  expect(await ui.ready).toBe(busy);
  expect(ui.url()).toBe(`http://localhost:${busy}/`);
  // Bound to 127.0.0.1: reachable there, and nowhere else.
  const { port } = await serve();
  expect((await call(port)).status).toBe(200);
  const other = await new Promise<string>((ok) => {
    const s = createServer()
      .once("error", (e: NodeJS.ErrnoException) => ok(e.code ?? ""))
      .listen(port, "0.0.0.0", () => {
        s.close(() => ok("free"));
      });
  });
  // The loopback-only socket leaves the wildcard address free (or the OS refuses the overlap).
  expect(["free", "EADDRINUSE"]).toContain(other);
});

test("ui: loop serves the page", async () => {
  const { ui, port } = await serve();
  for (const path of ["/", "/queue", "/activity", `/i/${IDS.plan}`]) {
    const r = await call(port, { path });
    expect(r.status, path).toBe(200);
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.body).toContain(`<meta name="towercab-token" content="${ui.token}">`);
  }
  expect(ui.token).toMatch(/^[0-9a-f]{64}$/);
  const js = await call(port, { path: "/assets/app.js" });
  expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
  expect((await call(port, { path: "/assets/app.css" })).headers["content-type"]).toBe(
    "text/css; charset=utf-8",
  );
  for (const path of ["/nope", "/assets/../index.html", "/assets/%2e%2e/index.html", "/.env"]) {
    expect((await call(port, { path })).status, path).toBe(404);
  }
  const state = await call(port, { path: "/api/state" });
  expect(state.status).toBe(200);
  expect(JSON.parse(state.body).top.needs).toBe(4);
  // Without a built page the loop still serves, and says how to build it.
  const bare = await serve({ distDir: join(tempDir(), "missing") });
  const page = await call(bare.port);
  expect(page.status).toBe(200);
  expect(page.body).toContain("npm run build:ui");
  expect(page.body).toContain(`content="${bare.ui.token}"`);
});

test("ui: host, origin and token are checked", async () => {
  const { f, ui, port } = await serve();
  const evil = await call(port, { headers: { Host: "evil.example:80" } });
  expect(evil.status).toBe(421);
  expect((await call(port, { path: "/api/state", headers: { Host: `localhost:${port}` } })).status).toBe(200);
  expect((await call(port, { path: "/api/state", headers: { Host: `[::1]:${port}` } })).status).toBe(200);
  expect((await call(port, { path: "/api/state", headers: { Host: `127.0.0.1:${port + 1}` } })).status).toBe(
    421,
  );
  const body = { action: "pause" };
  expect((await post(port, ui.token, body, { Origin: "http://evil.example" })).status).toBe(403);
  expect((await post(port, ui.token, body, { Origin: "" })).status).toBe(403);
  expect((await post(port, "0".repeat(64), body)).status).toBe(403);
  expect((await post(port, "short", body)).status).toBe(403);
  expect(f.calls).toEqual([]);
  const ok = await post(port, ui.token, body);
  expect(ok.status).toBe(200);
  expect(JSON.parse(ok.body)).toEqual({ ok: true, message: "Paused: nothing new starts until you resume." });
  expect(f.calls).toEqual([{ action: "pause" }]);
  for (const r of [evil, ok, await call(port, { path: "/" }), await call(port, { path: "/api/queue" })]) {
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toMatch(/^default-src 'self'/);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  }
  expect((await call(port, { method: "PUT", path: "/api/actions" })).status).toBe(405);
  // Read-only (no loop): actions are refused with a reason.
  const ro = await serve({ actions: null });
  const refused = await post(ro.port, ro.ui.token, body);
  expect(refused.status).toBe(409);
  expect(JSON.parse(refused.body).message).toMatch(/read-only/);
});

test("ui: secrets are redacted", async () => {
  const config = testConfig({
    telegram: { bot_token: "123456789:AAEhBP0av18fOcmZsY6nX_eBTXqnaTb3sN8", chat_id: "1" },
  });
  const text = [
    "token ghs_abcdefghijklmnopqrstuvwxyz0123",
    "pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "classic ghp_abcdefghijklmnopqrstuvwx1234",
    "bot https://api.telegram.org/bot123456789:AAEhBP0av18fOcmZsY6nX_eBTXqnaTb3sN8/sendMessage",
    "Authorization: Bearer eyJhbGciOi.payload.sig",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const r = redact(text, config);
  for (const s of ["ghs_", "github_pat_", "ghp_", "AAEhBP0av", "eyJhbGciOi", "MIIE"])
    expect(r).not.toContain(s);
  expect(r).toContain("<private key>");
  expect(r).toContain("Authorization: <token>");
  // Through the API: a reason holding a token never leaves the server.
  const f = buildFixture();
  f.db.run(
    "UPDATE missions SET why = ? WHERE intent = ?",
    "push failed: ghs_abcdefghijklmnopqrstuvwxyz0123 denied",
    IDS.question,
  );
  const { port } = await serve({ fixture: f });
  const state = await call(port, { path: "/api/state" });
  expect(state.body).not.toContain("ghs_abcdef");
  expect(state.body).toContain("push failed: <token> denied");
  writeFileSync(join(f.home.runs(IDS.plan), "build-1.log"), "using ghp_abcdefghijklmnopqrstuvwx1234 now\n");
  const file = await call(port, { path: `/api/runs/${IDS.plan}/build-1.log` });
  expect(file.body).toBe("using <token> now\n");
  expect(JSON.stringify(f.sources.config)).not.toContain("bot_token");
  expect(state.body).not.toMatch(/app\.pem|telegram/i);
});

test("ui: API shapes", async () => {
  const { f, ui, port } = await serve();
  const json = async (path: string) => {
    const r = await call(port, { path });
    expect(r.headers["content-type"], path).toBe("application/json; charset=utf-8");
    return { status: r.status, body: JSON.parse(r.body) as Record<string, unknown> };
  };
  const state = await json("/api/state");
  expect(Object.keys(state.body).sort()).toEqual([
    "airspace",
    "needs",
    "problems",
    "queued",
    "spend",
    "top",
    "upNext",
    "version",
    "working",
  ]);
  expect(state.body.version).toMatch(/^[0-9a-f]{12}$/);
  const intent = await json(`/api/intents/${IDS.plan}`);
  expect(intent.body).toMatchObject({ id: IDS.plan, title: "Rate-limit the public API" });
  expect(Object.keys(intent.body)).toEqual(
    expect.arrayContaining([
      "prs",
      "card",
      "timeline",
      "times",
      "attempts",
      "sections",
      "answers",
      "runs",
      "file",
    ]),
  );
  const missing = await json("/api/intents/999999-0000-9");
  expect(missing.status).toBe(404);
  expect(missing.body.error).toBe("There is no intent 999999-0000-9.");
  const queue = await json("/api/queue");
  expect((queue.body.lanes as unknown[]).length).toBe(6);
  const act = await json(`/api/activity?intent=${IDS.plan}&kind=waits`);
  expect(act.body).toMatchObject({ more: false });
  expect((act.body.items as { kind: string }[]).map((i) => i.kind)).toEqual(["wait", "wait"]);
  expect((await json("/api/nope")).status).toBe(404);
  // Actions: {action, intent, text?} → {ok, message}.
  const reply = await post(port, ui.token, {
    action: "reply",
    intent: IDS.question,
    text: "One row per currency.",
  });
  expect(JSON.parse(reply.body)).toEqual({
    ok: true,
    message: "Answer saved to the intent. Towercab goes on with it on its next pass.",
  });
  expect(f.calls.at(-1)).toEqual({ action: "reply", intent: IDS.question, text: "One row per currency." });
  const empty = await post(port, ui.token, { action: "reply", intent: IDS.question, text: " " });
  expect(empty.status).toBe(422);
  expect(JSON.parse(empty.body)).toEqual({ ok: false, message: "Write a reply first." });
  expect((await post(port, ui.token, { action: "explode", intent: IDS.plan })).status).toBe(400);
  expect((await post(port, ui.token, { action: "merge", intent: "../x" })).status).toBe(400);
  expect(
    (
      await call(port, {
        method: "POST",
        path: "/api/actions",
        headers: { Origin: `http://127.0.0.1:${port}`, "X-Towercab-Token": ui.token },
        body: "{",
      })
    ).status,
  ).toBe(400);
  // Events: a version now, and a new one when something changes.
  const versions = await new Promise<string[]>((ok, fail) => {
    const seen: string[] = [];
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/events", headers: { Host: `127.0.0.1:${port}` } },
      (res) => {
        expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
        let buf = "";
        res.on("data", (c: Buffer) => {
          buf += c.toString();
          for (const m of buf.matchAll(/event: version\ndata: ([0-9a-f]+)\n\n/g))
            if (!seen.includes(m[1]!)) seen.push(m[1]!);
          if (seen.length === 1 && !f.state.paused) {
            f.state.paused = true;
            ui.changed();
          }
          if (seen.length === 2) {
            req.destroy();
            ok(seen);
          }
        });
      },
    );
    req.on("error", (e: Error) => (seen.length === 2 ? undefined : fail(e)));
    req.end();
  });
  expect(versions[0]).not.toBe(versions[1]);
});

test("ui: run files stay inside runs", async () => {
  const f = buildFixture();
  const { port } = await serve({ fixture: f });
  const runs = f.home.runs(IDS.plan);
  writeFileSync(join(f.home.root, "secret.txt"), "top secret");
  writeFileSync(join(runs, ".hidden"), "hidden");
  symlinkSync(join(f.home.root, "secret.txt"), join(runs, "link.txt"));
  mkdirSync(join(runs, "shots-1"));
  writeFileSync(join(runs, "big.log"), `${"x".repeat(3 * 1024 * 1024)}END`);
  const ok = await call(port, { path: `/api/runs/${IDS.plan}/plan-1.prompt.md` });
  expect(ok.status).toBe(200);
  expect(ok.headers["content-type"]).toBe("text/plain; charset=utf-8");
  expect(ok.headers["content-security-policy"]).toMatch(/sandbox/);
  expect(ok.body).toContain("# Plan");
  for (const bad of [
    "link.txt",
    ".hidden",
    "nope.txt",
    "shots-1",
    "..%2Fsecret.txt",
    "..%2F..%2Fsecret.txt",
    "%2E%2E",
  ]) {
    expect((await call(port, { path: `/api/runs/${IDS.plan}/${bad}` })).status, bad).toBe(404);
  }
  expect((await call(port, { path: "/api/runs/../secret.txt" })).status).toBe(404);
  expect((await call(port, { path: "/api/runs/..%2F/secret.txt" })).status).toBe(404);
  expect((await call(port, { path: `/api/runs/${IDS.plan}/../../secret.txt` })).status).toBe(404);
  const big = await call(port, { path: `/api/runs/${IDS.plan}/big.log` });
  expect(big.status).toBe(200);
  expect(big.body.length).toBeLessThan(2 * 1024 * 1024 + 200);
  expect(big.body.endsWith("END")).toBe(true);
  expect(big.body).toMatch(/^… the first \d+ KB are cut/);
});
