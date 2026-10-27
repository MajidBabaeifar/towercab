// HTTP for the UI tests: node:http, so a test can set Host and Origin.

import { request } from "node:http";

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function call(
  port: number,
  o: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: o.method ?? "GET",
        path: o.path ?? "/",
        headers: { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () =>
          ok({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", fail);
    if (o.body) req.write(o.body);
    req.end();
  });
}

/** A POST to /api/actions with the right Origin and token unless overridden. */
export function post(
  port: number,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return call(port, {
    method: "POST",
    path: "/api/actions",
    headers: {
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${port}`,
      "X-Towercab-Token": token,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
