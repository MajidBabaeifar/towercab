// Webhooks (LOOP-146..149): each `[[notify.webhook]]` gets every outbox row beside Telegram, as JSON posted
// to a URL that is read from a mode-600 file at each send and never kept. Delivery state is per
// destination (`outbox_sent`), so a failing webhook never holds back Telegram or another webhook.

import { type Config, readTokenFile, type WebhookConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { fetchHttp, type Http } from "./github/app.ts";
import { emit } from "./log.ts";
import { envBackoff, finished, type Stage } from "./machine.ts";
import { minimalText, renderTemplate, urlProblem } from "./notify-text.ts";
import type { OutboxRow } from "./outbox.ts";
import { MAX_TEXT } from "./telegram.ts";

export const WEBHOOK_TIMEOUT_MS = 10_000;

/** Row kinds that only make sense in Telegram: an edit of a message and the answer to a button press. */
const TELEGRAM_ONLY = ["edit", "answer"];

/** LOOP-149: missions that wait on the owner now. */
export function waitingCount(db: Db): number {
  return db
    .all<{ stage: string }>("SELECT stage FROM missions WHERE waiting IS NOT NULL")
    .filter((m) => !finished(m.stage as Stage)).length;
}

/** The local page's address, or null when the page is off (`[ui] port = 0`). */
export function pageLink(config: Config): string | null {
  return config.ui.port ? `http://localhost:${config.ui.port}/` : null;
}

export interface WebhookDeps {
  http?: Http;
  log?: (line: string) => void;
  /** How many missions wait on the owner when a message goes out (`minimal`). */
  waiting: () => number;
  link: string | null;
}

/** A reason for the log and the retry record. It is built from a few safe shapes, never from the URL. */
function reasonOf(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (/timed out/i.test(m)) return "timeout";
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(m)) return m;
  return "network error";
}

export class Webhook {
  readonly name: string;
  readonly dest: string;
  private cfg: WebhookConfig;
  private d: WebhookDeps;
  /** A failure was logged and nothing has worked since. */
  private down = false;

  constructor(cfg: WebhookConfig, d: WebhookDeps) {
    this.cfg = cfg;
    this.d = d;
    this.name = cfg.name;
    this.dest = `webhook:${cfg.name}`;
  }

  /** The body for one outbox row's text (LOOP-148, LOOP-149). */
  body(text: string): string {
    const link = this.d.link ?? "";
    const said = this.cfg.detail === "full" ? text : minimalText(this.d.waiting(), this.d.link);
    const cut = [...said];
    const msg = cut.length > MAX_TEXT ? `${cut.slice(0, MAX_TEXT - 1).join("")}…` : said;
    return renderTemplate(this.cfg.template, msg, link);
  }

  /** POST the message; resolves on a 2xx and rejects with a reason that never holds the URL. */
  async send(text: string): Promise<void> {
    let why: string | null = null;
    const file = readTokenFile(this.cfg.urlFile);
    if ("why" in file) {
      why = `url_file ${file.why}`;
    } else {
      const bad = urlProblem(file.token);
      if (bad) {
        why = `url_file: ${bad}`;
      } else {
        try {
          const r = await (this.d.http ?? fetchHttp)({
            method: "POST",
            url: file.token,
            headers: { "Content-Type": "application/json" },
            body: this.body(text),
            timeoutMs: WEBHOOK_TIMEOUT_MS,
            redirect: "manual",
          });
          if (r.status < 200 || r.status > 299) {
            why = r.status >= 300 && r.status < 400 ? `redirect (HTTP ${r.status})` : `HTTP ${r.status}`;
          }
        } catch (e) {
          why = reasonOf(e);
        }
      }
    }
    const log = this.d.log ?? emit;
    if (why === null) {
      if (this.down) log(`webhook ${this.name}: sending again`);
      this.down = false;
      return;
    }
    const msg = `webhook ${this.name}: ${why}`;
    if (!this.down) {
      this.down = true;
      log(msg);
    }
    throw new Error(msg);
  }
}

/** One webhook per `[[notify.webhook]]` table. */
export function buildWebhooks(config: Config, db: Db, o: { http?: Http; log?: (line: string) => void } = {}) {
  const link = pageLink(config);
  return config.notify.webhooks.map((w) => new Webhook(w, { ...o, waiting: () => waitingCount(db), link }));
}

export interface WebhookResult {
  sent: number;
  /** Rows whose wait was over, dropped for this webhook. */
  dropped: number;
  /** Webhook name → the failure that stopped its round. */
  failed: Record<string, string>;
}

function record(db: Db, key: string, dest: string, sentAt: number | null, tries: number, nextTry: number) {
  db.run(
    `INSERT INTO outbox_sent (key, dest, sent_at, tries, next_try) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key, dest) DO UPDATE SET sent_at = excluded.sent_at, tries = excluded.tries, next_try = excluded.next_try`,
    key,
    dest,
    sentAt,
    tries,
    nextTry,
  );
}

/**
 * LOOP-146: for each webhook, its unsent rows oldest first: obsolete ones dropped for it (`sent_at = 0`);
 * the rest sent until its first failure or a row whose retry isn't due. A webhook sees only rows written
 * since it first appeared; Telegram's edits and button answers never go to it. A failure never throws.
 */
export async function sendWebhooks(
  db: Db,
  hooks: Webhook[],
  now: number,
  isObsolete: (row: OutboxRow) => boolean,
): Promise<WebhookResult> {
  const out: WebhookResult = { sent: 0, dropped: 0, failed: {} };
  // A row that left the outbox leaves its delivery marks too.
  db.run("DELETE FROM outbox_sent WHERE key NOT IN (SELECT key FROM outbox)");
  for (const hook of hooks) {
    const addedKey = `notify.added.${hook.dest}`;
    const added = Number(db.meta(addedKey) ?? Number.NaN);
    let since = added;
    if (!Number.isFinite(added)) {
      since = now;
      db.setMeta(addedKey, String(now));
    }
    const rows = db.all<OutboxRow & { d_tries: number | null; d_next: number | null }>(
      `SELECT o.*, s.tries AS d_tries, s.next_try AS d_next FROM outbox o
       LEFT JOIN outbox_sent s ON s.key = o.key AND s.dest = ?
       WHERE o.kind NOT IN (${TELEGRAM_ONLY.map(() => "?").join(", ")}) AND o.created >= ?
         AND (s.key IS NULL OR s.sent_at IS NULL)
       ORDER BY o.created, o.rowid`,
      hook.dest,
      ...TELEGRAM_ONLY,
      since,
    );
    for (const row of rows) {
      const tries = row.d_tries ?? 0;
      if (isObsolete(row)) {
        record(db, row.key, hook.dest, 0, tries, row.d_next ?? 0);
        out.dropped++;
        continue;
      }
      if ((row.d_next ?? 0) > now) break;
      try {
        await hook.send(row.text);
      } catch (e) {
        record(db, row.key, hook.dest, null, tries + 1, now + envBackoff(tries));
        out.failed[hook.name] = e instanceof Error ? e.message : String(e);
        break;
      }
      record(db, row.key, hook.dest, now, tries, 0);
      out.sent++;
    }
  }
  return out;
}
