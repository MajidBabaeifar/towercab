// Webhook tests (LOOP-146..149): fake HTTP, URL files and outbox rows, no network.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WebhookConfig } from "../../src/config.ts";
import type { Db } from "../../src/db.ts";
import type { HttpRequest, HttpResponse } from "../../src/github/app.ts";
import { insertMission } from "../../src/mission.ts";
import { Webhook, waitingCount } from "../../src/notify.ts";
import { DEFAULT_TEMPLATE } from "../../src/notify-text.ts";
import { tempDir } from "./world.ts";

/** A made-up secret URL: tests look for it in logs, errors and rows. */
export const SECRET_URL = "https://chat.example.com/hooks/T0K3N-s3cr3t";
export const PAGE = "http://localhost:7311/";

/** A URL file with `url` on one line and the given mode. */
export function urlFile(url: string = SECRET_URL, mode = 0o600): string {
  const f = join(tempDir("tc-hook-"), "url");
  writeFileSync(f, `${url}\n`);
  chmodSync(f, mode);
  return f;
}

/** The chat service: answers from a queue (then 200), recording each request. */
export function fakeHttp() {
  const requests: HttpRequest[] = [];
  const queue: (HttpResponse | Error)[] = [];
  const http = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { status: 200, text: "ok" };
  };
  return { requests, queue, http };
}

export function hookConfig(o: Partial<WebhookConfig> = {}): WebhookConfig {
  return {
    name: "team",
    urlFile: urlFile(),
    template: DEFAULT_TEMPLATE,
    detail: "minimal",
    ...o,
  };
}

/** One webhook over `db`: its page link is `PAGE`, its waits are the database's. */
export function webhook(
  db: Db,
  http: (req: HttpRequest) => Promise<HttpResponse>,
  o: Partial<WebhookConfig> = {},
  log: (line: string) => void = () => {},
  link: string | null = PAGE,
): Webhook {
  return new Webhook(hookConfig(o), { http, log, waiting: () => waitingCount(db), link });
}

let n = 0;
/** An outbox row (not tied to a mission). */
export function addRow(db: Db, text: string, created: number, kind = "info", key = `row:${n++}`): string {
  db.run(
    "INSERT INTO outbox (key, mission, text, created, kind) VALUES (?, NULL, ?, ?, ?)",
    key,
    text,
    created,
    kind,
  );
  return key;
}

/** A mission that waits on the owner (`count` of them). */
export function waiters(db: Db, count: number): void {
  for (let i = 0; i < count; i++) {
    const m = insertMission(
      db,
      { intent: `261001-09${i}${n++}`, slug: "x", repo: "web", model: "opus", a: 3 },
      0,
    );
    db.run("UPDATE missions SET stage = 'design', step = '', waiting = 'approve spec' WHERE id = ?", m.id);
  }
}

export function sentTo(db: Db, dest: string): string[] {
  return db
    .all<{ key: string }>(
      "SELECT key FROM outbox_sent WHERE dest = ? AND sent_at IS NOT NULL AND sent_at > 0 ORDER BY key",
      dest,
    )
    .map((r) => r.key);
}
