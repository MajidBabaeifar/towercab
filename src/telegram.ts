// Telegram (LOOP-16): only delivers Towercab's messages through the Bot API's `sendMessage`.
// Failures are logged once per outage with the token masked; the outbox retries.

import type { Config } from "./config.ts";
import { fetchHttp, type Http } from "./github/app.ts";
import { emit } from "./log.ts";
import type { Sender } from "./outbox.ts";

/** Longest message sent (Telegram's limit is 4096). */
export const MAX_TEXT = 4000;
export const TELEGRAM_TIMEOUT_MS = 10_000;

export type TelegramConfig = NonNullable<Config["telegram"]>;

export class Telegram implements Sender {
  private config: TelegramConfig;
  private http: Http;
  private log: (line: string) => void;
  /** A failure was logged and nothing has worked since. */
  private down = false;

  constructor(config: TelegramConfig, http: Http = fetchHttp, log: (line: string) => void = emit) {
    this.config = config;
    this.http = http;
    this.log = log;
  }

  /**
   * `POST <api_base>/bot<token>/sendMessage` `{chat_id, text, disable_web_page_preview: true}`;
   * sent = HTTP 200 and `ok: true`. Rejects with a reason that never holds the token.
   */
  async send(text: string): Promise<void> {
    const cut = [...text];
    const body = {
      chat_id: this.config.chatId,
      text: cut.length > MAX_TEXT ? `${cut.slice(0, MAX_TEXT - 1).join("")}…` : text,
      disable_web_page_preview: true,
    };
    let why: string | null = null;
    try {
      const r = await this.http({
        method: "POST",
        url: `${this.config.apiBase}/bot${this.config.botToken}/sendMessage`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: TELEGRAM_TIMEOUT_MS,
      });
      let v: { ok?: unknown; description?: unknown } = {};
      try {
        v = JSON.parse(r.text) as typeof v;
      } catch {
        // Not JSON: a proxy's error page.
      }
      if (r.status !== 200 || v.ok !== true) {
        why = `HTTP ${r.status}: ${typeof v.description === "string" ? v.description : "ok is not true"}`;
      }
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    if (why === null) {
      this.down = false;
      return;
    }
    const msg = `telegram sendMessage: ${this.mask(why)}`;
    if (!this.down) {
      this.down = true;
      this.log(msg);
    }
    throw new Error(msg);
  }

  private mask(s: string): string {
    return s.replaceAll(this.config.botToken, "<token>").replace(/\s+/g, " ").trim();
  }
}
