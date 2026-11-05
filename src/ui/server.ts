// The page's HTTP server (UI-1, UI-4, UI-65): 127.0.0.1 only, the built page from ui/dist, a JSON API,
// Server-Sent Events. It never blocks or fails the loop: a busy port is retried every 30 s.

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { isRepoName } from "../intents/features.ts";
import type { IntentStore, Listing } from "../intents/types.ts";
import type { UiActions } from "./actions.ts";
import { board } from "./board.ts";
import { focus } from "./focus.ts";
import { repos } from "./repos.ts";
import { activity, intentPage, overview, queue, RUN_NAME, redact, type UiSources } from "./state.ts";
import type { ActionReply } from "./view.ts";

export interface UiOptions {
  /** 0 = any free port (tests, the fixture); the caller treats `[ui] port = 0` as off. */
  port: number;
  sources: UiSources;
  /** null = read-only (the CLI without a loop, UI-2). */
  actions: UiActions | null;
  /** The built page (`ui/dist`); missing → a page saying how to build it. */
  distDir: string;
  log(line: string): void;
  /** Retry a busy port after this long (default 30 s). */
  retryMs?: number;
  /** How often the event stream checks for a new version (default 2 s). */
  pollMs?: number;
  /** How long one intents listing is reused (default 2 s). */
  listTtlMs?: number;
}

export interface UiServer {
  /** The per-process token (32 bytes, hex) a POST must carry. */
  readonly token: string;
  /** Resolves with the bound port once listening. */
  readonly ready: Promise<number>;
  port(): number | null;
  url(): string | null;
  /** Something changed: push a new version to open pages now. */
  changed(): void;
  stop(): Promise<void>;
}

export const MAX_BODY = 64 * 1024;
export const MAX_RUN_FILE = 2 * 1024 * 1024;

const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const BASE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": CSP,
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const PAGES = /^\/(?:board|focus|repos|queue|activity|i\/[A-Za-z0-9._-]+)?\/?$/;
const ACTIONS = new Set([
  "merge",
  "reply",
  "retry",
  "drop",
  "start",
  "step",
  "secret",
  "approve-secret",
  "done",
  "steps",
  "pause",
  "resume",
  "granted",
  "addRepo",
  "features",
  "accept",
  "close",
]);
const INTENT_ID = /^[A-Za-z0-9._-]{1,100}$/;

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="towercab-token" content=""><title>Towercab</title></head>
<body><h1>Towercab</h1><p>The page isn't built yet. Run <code>npm run build:ui</code> in Towercab's checkout, then reload.</p>
<p>The API answers at <a href="/api/state">/api/state</a>.</p></body></html>`;

/** An intent store whose `list` is reused for `ttlMs` (the page and the event stream read it often). */
function cachingStore(store: IntentStore, ttlMs: number): IntentStore & { invalidate(): void } {
  let cached: { at: number; p: Promise<Listing> } | null = null;
  return {
    list() {
      const now = performance.now();
      if (!cached || now - cached.at > ttlMs) {
        const p = store.list();
        cached = { at: now, p };
        p.catch(() => {
          if (cached?.p === p) cached = null;
        });
      }
      return cached.p;
    },
    get: (x) => store.get(x),
    add: (n, now) => store.add(n, now),
    update: (x, what, fn, mark) => store.update(x, what, fn, mark),
    hasMark: (m) => store.hasMark(m),
    readFile: (p) => store.readFile(p),
    editFeatures: (repo, what, fn) => store.editFeatures(repo, what, fn),
    localFeatures: (repo) => store.localFeatures(repo),
    github: () => store.github(),
    url: (i) => store.url(i),
    invalidate() {
      cached = null;
    },
  };
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Start the page's server (UI-1). Never throws for a busy port: it logs once and retries. */
export function startUi(o: UiOptions): UiServer {
  const token = randomBytes(32).toString("hex");
  const store = cachingStore(o.sources.store, o.listTtlMs ?? 2000);
  const src: UiSources = Object.assign(Object.create(o.sources) as UiSources, { store });
  const config = o.sources.config;
  const clients = new Set<ServerResponse>();
  const logged = new Set<string>();
  let bound: number | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  let lastVersion = "";
  let ticks = 0;
  let resolveReady: (port: number) => void = () => {};
  const ready = new Promise<number>((r) => {
    resolveReady = r;
  });

  const once = (line: string) => {
    if (logged.has(line)) return;
    logged.add(line);
    o.log(line);
  };

  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra = {}) => {
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": type, ...extra });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown) =>
    send(res, status, "application/json; charset=utf-8", redact(JSON.stringify(value), config));

  const hostOk = (host: string | undefined) =>
    bound !== null && !!host && [`127.0.0.1:${bound}`, `localhost:${bound}`, `[::1]:${bound}`].includes(host);

  const indexHtml = (): string => {
    const file = join(o.distDir, "index.html");
    let html: string;
    try {
      html = readFileSync(file, "utf8");
    } catch {
      html = NOT_BUILT;
    }
    const meta = `<meta name="towercab-token" content="${token}">`;
    return /<meta name="towercab-token"[^>]*>/.test(html)
      ? html.replace(/<meta name="towercab-token"[^>]*>/, meta)
      : html.replace("</head>", `${meta}</head>`);
  };

  const staticFile = (res: ServerResponse, pathname: string): boolean => {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname).replace(/^\/+/, "");
    } catch {
      return false;
    }
    if (!rel || rel.includes("\0") || rel.split(/[\\/]/).some((p) => p === ".." || p.startsWith(".")))
      return false;
    const type = TYPES[extname(rel).toLowerCase()];
    if (!type || rel === "index.html") return false;
    const root = resolve(o.distDir);
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep)) return false;
    try {
      if (!statSync(file).isFile()) return false;
      send(res, 200, type, readFileSync(file));
      return true;
    } catch {
      return false;
    }
  };

  const runFile = (res: ServerResponse, id: string, parts: string[]) => {
    const bad = (s: string) => !RUN_NAME.test(s) || s.startsWith(".") || s === "..";
    if (bad(id) || parts.some(bad)) return json(res, 404, { error: "No such run file." });
    const dir = join(o.sources.home.root, "runs", id);
    const file = join(dir, ...parts);
    try {
      const st = lstatSync(file);
      if (!st.isFile()) return json(res, 404, { error: "No such run file." });
      if (!realpathSync(file).startsWith(realpathSync(dir) + sep)) {
        return json(res, 404, { error: "No such run file." });
      }
      const size = Number(st.size);
      const length = Math.min(size, MAX_RUN_FILE);
      const buf = Buffer.alloc(length);
      const fd = openSync(file, "r");
      try {
        readSync(fd, buf, 0, length, size - length);
      } finally {
        closeSync(fd);
      }
      let text = buf.toString("utf8");
      if (size > length)
        text = `… the first ${Math.round((size - length) / 1024)} KB are cut; this is the end of the file.\n${text}`;
      send(res, 200, "text/plain; charset=utf-8", redact(text, config), {
        "Content-Security-Policy": `${CSP}; sandbox`,
      });
    } catch {
      json(res, 404, { error: "No such run file." });
    }
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((ok, fail) => {
      let size = 0;
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          fail(new Error("too large"));
          req.destroy();
        } else parts.push(c);
      });
      req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
      req.on("error", fail);
    });

  const act = async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin !== `http://${host}`) return json(res, 403, { ok: false, message: "Refused: wrong origin." });
    const t = req.headers["x-towercab-token"];
    if (typeof t !== "string" || !sameToken(t, token)) {
      return json(res, 403, { ok: false, message: "Refused: the page is out of date. Reload it." });
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      return json(res, 413, { ok: false, message: "The request is too large." });
    }
    let body: {
      action?: unknown;
      intent?: unknown;
      text?: unknown;
      github?: unknown;
      name?: unknown;
      repo?: unknown;
      n?: unknown;
      done?: unknown;
      value?: unknown;
      pr?: unknown;
      head?: unknown;
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { ok: false, message: "The request isn't JSON." });
    }
    const action = typeof body.action === "string" ? body.action : "";
    const intent = typeof body.intent === "string" ? body.intent : "";
    const repo = typeof body.repo === "string" ? body.repo : "";
    if (!ACTIONS.has(action)) return json(res, 400, { ok: false, message: `Unknown action “${action}”.` });
    const proposal = action === "accept" || action === "close";
    const needsIntent = !["pause", "resume", "granted", "addRepo", "features", "accept", "close"].includes(
      action,
    );
    if (needsIntent && !INTENT_ID.test(intent))
      return json(res, 400, { ok: false, message: "Which intent?" });
    const pr = typeof body.pr === "number" && Number.isSafeInteger(body.pr) && body.pr > 0 ? body.pr : 0;
    if (proposal && !pr) return json(res, 400, { ok: false, message: "Which pull request?" });
    const head = typeof body.head === "string" ? body.head : "";
    if (action === "accept" && !/^[0-9a-f]{7,64}$/.test(head))
      return json(res, 400, { ok: false, message: "Which version of the pull request?" });
    if (action === "features" && !isRepoName(repo))
      return json(res, 400, { ok: false, message: "Which repo?" });
    if (!o.actions) {
      return json(res, 409, {
        ok: false,
        message: "Towercab isn't running, so this page is read-only. Start it with towercab up.",
      });
    }
    const a = o.actions;
    let reply: ActionReply;
    try {
      const no = () => Promise.reject(new Error("Secrets aren't available."));
      const message =
        action === "secret"
          ? await (a.secret ?? no)(intent, Number(body.n), typeof body.value === "string" ? body.value : "")
          : action === "approve-secret"
            ? await (a.approveSecret ?? no)(intent, Number(body.n))
            : action === "merge"
              ? await a.merge(intent)
              : action === "reply"
                ? await a.reply(intent, typeof body.text === "string" ? body.text : "")
                : action === "retry"
                  ? await a.retry(intent)
                  : action === "drop"
                    ? await a.drop(intent)
                    : action === "done"
                      ? await (
                          a.done ?? (() => Promise.reject(new Error("Ending an intent isn't available.")))
                        )(intent, typeof body.text === "string" ? body.text : "")
                      : action === "steps"
                        ? await (
                            a.steps ??
                            (() => Promise.reject(new Error("Switching to steps isn't available.")))
                          )(intent)
                        : action === "start"
                          ? await a.start(intent)
                          : action === "step"
                            ? await (
                                a.step ?? (() => Promise.reject(new Error("Ticking steps isn't available.")))
                              )(intent, Number(body.n), body.done !== false)
                            : action === "pause"
                              ? await a.pause()
                              : action === "addRepo"
                                ? await a.addRepo(
                                    typeof body.github === "string" ? body.github : "",
                                    typeof body.name === "string" && body.name ? body.name : undefined,
                                  )
                                : action === "features"
                                  ? await a.features(repo)
                                  : action === "accept"
                                    ? await a.accept(pr, head)
                                    : action === "close"
                                      ? await a.close(
                                          pr,
                                          typeof body.text === "string" ? body.text : undefined,
                                        )
                                      : action === "granted"
                                        ? await (
                                            a.granted ?? (() => Promise.reject(new Error("Not available.")))
                                          )()
                                        : await a.resume();
      reply = { ok: true, message };
    } catch (e) {
      reply = { ok: false, message: (e as Error).message };
    }
    store.invalidate();
    changed();
    return json(res, reply.ok ? 200 : 422, reply);
  };

  const events = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    });
    res.write("retry: 5000\n\n");
    if (lastVersion) res.write(`event: version\ndata: ${lastVersion}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    void tick();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostOk(req.headers.host)) return send(res, 421, "text/plain; charset=utf-8", "Wrong host.");
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (req.method === "POST") {
      if (path === "/api/actions") return act(req, res);
      return json(res, 404, { error: "Not found." });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, "text/plain; charset=utf-8", "GET or POST only.", { Allow: "GET, POST" });
    }
    if (path === "/api/state") return json(res, 200, await overview(src));
    if (path === "/api/queue") return json(res, 200, await queue(src));
    if (path === "/api/board") return json(res, 200, await board(src));
    if (path === "/api/focus") {
      // UI-195: the waits the page has just acted on; anything that isn't a plain key is ignored.
      const skip = (url.searchParams.get("skip") ?? "")
        .split(",")
        .filter((k) => /^[A-Za-z0-9._-]{1,40}$/.test(k))
        .slice(0, 50);
      return json(res, 200, await focus(src, skip));
    }
    if (path === "/api/repos") {
      const a = o.actions;
      // UI-144: a repo's first look asks once for its backfill, while Towercab runs.
      const ask = a && src.running ? (r: string) => a.features(r) : undefined;
      const page = await repos(src, url.searchParams.get("repo") || null, { ask });
      return json(res, 200, page);
    }
    if (path === "/api/events") return events(req, res);
    if (path === "/api/activity") {
      const q = url.searchParams;
      const str = (k: string) => q.get(k) || undefined;
      return json(
        res,
        200,
        await activity(src, {
          intent: str("intent"),
          repo: str("repo"),
          kind: str("kind"),
          since: str("since"),
          offset: Number(q.get("offset") ?? 0) || 0,
        }),
      );
    }
    let m = /^\/api\/intents\/([^/]+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const page = INTENT_ID.test(id) ? await intentPage(src, id) : null;
      return page ? json(res, 200, page) : json(res, 404, { error: `There is no intent ${id}.` });
    }
    // `<file>` of the flat layout, or `<stage>/<file>` (LOOP-41).
    m = /^\/api\/runs\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (m) {
      let id: string;
      let parts: string[];
      try {
        id = decodeURIComponent(m[1]!);
        parts = [m[2]!, m[3]].filter((x): x is string => x !== undefined).map(decodeURIComponent);
      } catch {
        return json(res, 404, { error: "No such run file." });
      }
      return runFile(res, id, parts);
    }
    if (path.startsWith("/api/")) return json(res, 404, { error: "Not found." });
    if (PAGES.test(path)) return send(res, 200, "text/html; charset=utf-8", indexHtml());
    if (staticFile(res, path)) return;
    send(res, 404, "text/plain; charset=utf-8", "Not found.");
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const msg = (e as Error)?.message ?? String(e);
      once(`ui: ${req.method} ${(req.url ?? "").split("?")[0]} failed: ${msg}`);
      if (!res.headersSent) json(res, 500, { error: `Towercab couldn't build this page: ${msg}` });
      else res.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;

  const tick = async () => {
    if (clients.size === 0 || stopped) return;
    ticks++;
    try {
      const v = (await overview(src)).version;
      if (v !== lastVersion) {
        lastVersion = v;
        for (const c of clients) c.write(`event: version\ndata: ${v}\n\n`);
      } else if (ticks % 12 === 0) {
        for (const c of clients) c.write(": ping\n\n");
      }
    } catch (e) {
      once(`ui: can't compute the page's state: ${(e as Error).message}`);
    }
  };
  const ticker = setInterval(() => void tick(), o.pollMs ?? 2000);
  ticker.unref();

  const changed = () => {
    void tick();
  };

  const listen = () => {
    if (stopped) return;
    server.listen(o.port, "127.0.0.1");
  };
  server.on("listening", () => {
    const addr = server.address();
    bound = typeof addr === "object" && addr ? addr.port : o.port;
    logged.clear();
    o.log(`http://localhost:${bound}/`);
    resolveReady(bound);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (stopped) return;
    once(
      e.code === "EADDRINUSE"
        ? `ui: port ${o.port} is in use; trying again every ${Math.round((o.retryMs ?? 30_000) / 1000)} s`
        : `ui: can't serve on 127.0.0.1:${o.port}: ${e.message}`,
    );
    retry = setTimeout(listen, o.retryMs ?? 30_000);
    retry.unref();
  });
  listen();

  return {
    token,
    ready,
    port: () => bound,
    url: () => (bound === null ? null : `http://localhost:${bound}/`),
    changed,
    stop: () =>
      new Promise<void>((done) => {
        stopped = true;
        clearInterval(ticker);
        if (retry) clearTimeout(retry);
        for (const c of clients) c.end();
        clients.clear();
        if (!server.listening) return done();
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

/** Whether the built page exists (for `doctor` and the not-built page). */
export function uiBuilt(distDir: string): boolean {
  return existsSync(join(distDir, "index.html"));
}
