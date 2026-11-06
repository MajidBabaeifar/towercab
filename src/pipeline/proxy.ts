// The allowlist proxy (PIP-158): a sandbox has no network of its own; Towercab's process listens on a unix
// socket that is bound into it, and only a granted domain on port 80 or 443 is connected to.

import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import {
  request as httpRequest,
  createServer as httpServer,
  type IncomingMessage,
  type Server,
} from "node:http";
import { connect, isIP, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainMatches } from "./domains.ts";

export type Lookup = (host: string) => Promise<string[]>;
export type Dial = (address: string, port: number) => Socket;

export interface ProxyOpts {
  domains: string[];
  /** Resolves a name to its addresses; tests inject one. */
  lookup?: Lookup;
  /** Opens the connection to a checked address; tests inject one. */
  dial?: Dial;
  /** Called with a line for every refusal. */
  log?: (line: string) => void;
}

/** True for loopback, private, link-local, unspecified and other non-public addresses. */
export function privateAddress(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(a) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return privateAddress(mapped[1]!);
    return (
      a === "::" ||
      a === "::1" ||
      a.startsWith("fe8") ||
      a.startsWith("fe9") ||
      a.startsWith("fea") ||
      a.startsWith("feb") ||
      a.startsWith("fc") ||
      a.startsWith("fd")
    );
  }
  const p = a.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true;
  const [x, y] = [p[0]!, p[1]!];
  return (
    x === 0 ||
    x === 10 ||
    x === 127 ||
    (x === 100 && y >= 64 && y <= 127) ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 192 && y === 0) ||
    (x === 198 && (y === 18 || y === 19)) ||
    x >= 224
  );
}

async function systemLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((r) => r.address);
}

/** Why a request to `host:port` is refused, or null with the address to connect to. */
export async function checkTarget(
  o: ProxyOpts,
  host: string,
  port: number,
): Promise<{ refuse: string } | { address: string }> {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (port !== 80 && port !== 443) return { refuse: `port ${port} is not 80 or 443` };
  if (isIP(h.replace(/^\[|\]$/g, ""))) return { refuse: `${h} is an IP address` };
  if (!o.domains.some((g) => domainMatches(g, h))) return { refuse: `${h} is not granted` };
  let addresses: string[];
  try {
    addresses = await (o.lookup ?? systemLookup)(h);
  } catch (e) {
    return { refuse: `${h} did not resolve: ${(e as Error).message}` };
  }
  if (!addresses.length) return { refuse: `${h} did not resolve` };
  // Every address must be public, so a name that also points inside cannot be used to get there.
  const bad = addresses.find(privateAddress);
  if (bad) return { refuse: `${h} resolves to a private address (${bad})` };
  return { address: addresses[0]! };
}

/** A proxy server for `o.domains`; listen on a unix socket with `listenOn`. */
export function proxyServer(o: ProxyOpts): Server {
  const dial: Dial = o.dial ?? ((address, port) => connect({ host: address, port }));
  const refuse = (what: string, why: string) => o.log?.(`proxy refused ${what}: ${why}`);
  const server = httpServer(async (req: IncomingMessage, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("a proxy request needs an absolute URL");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end("only http is proxied here; https uses CONNECT");
      return;
    }
    const port = Number(url.port || 80);
    const t = await checkTarget(o, url.hostname, port);
    if ("refuse" in t) {
      refuse(url.hostname, t.refuse);
      res.writeHead(403).end(`refused: ${t.refuse}`);
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    const up = httpRequest(
      {
        createConnection: () => dial(t.address, port),
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.writeHead(502).end("upstream failed"));
    req.pipe(up);
  });
  server.on("connect", async (req, client: Socket, head) => {
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
    const deny = (why: string) => {
      refuse(req.url ?? "?", why);
      client.end(`HTTP/1.1 403 Forbidden\r\n\r\nrefused: ${why}\r\n`);
    };
    if (!m) return deny("not a host:port");
    const t = await checkTarget(o, m[1]!, Number(m[2]));
    if ("refuse" in t) return deny(t.refuse);
    const up = dial(t.address, Number(m[2]));
    up.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    const end = () => {
      up.destroy();
      client.destroy();
    };
    up.on("error", end);
    client.on("error", end);
    up.on("close", end);
    client.on("close", end);
  });
  return server;
}

const servers = new Map<string, string>();
let cleanup = false;

/**
 * The socket of a proxy for exactly these domains, started on first use and shared after that, or null
 * for none (no domain: no socket is bound and nothing is reachable). The folder is private to the user and
 * the name is unique to this server, so another process (or a worker thread) never meets its socket.
 */
export function proxySocket(domains: string[], log?: (line: string) => void): string | null {
  const list = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))].sort();
  if (!list.length) return null;
  const key = createHash("sha256").update(list.join("\n")).digest("hex").slice(0, 12);
  const known = servers.get(key);
  if (known) return known;
  const dir = join(tmpdir(), `tc-proxy-${process.getuid?.() ?? 0}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${key}-${randomBytes(4).toString("hex")}.sock`);
  const server = proxyServer({ domains: list, log });
  server.listen(path);
  server.unref();
  servers.set(key, path);
  if (!cleanup) {
    cleanup = true;
    process.once("exit", () => {
      for (const p of servers.values()) rmSync(p, { force: true });
    });
  }
  return path;
}
