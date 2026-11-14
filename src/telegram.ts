// Telegram (LOOP-16, LOOP-129): delivers Towercab's messages through the Bot API's `sendMessage` and, for
// the shadow, reads the owner's messages with `getUpdates`. Failures are logged once per outage with the
// token masked; the outbox retries.

import type { Config } from "./config.ts";
import { fetchHttp, type Http } from "./github/app.ts";
import { emit } from "./log.ts";
import { type Button, Refused, type Sender } from "./outbox.ts";

/** Longest message sent (Telegram's limit is 4096). */
export const MAX_TEXT = 4000;
export const TELEGRAM_TIMEOUT_MS = 10_000;

export type TelegramConfig = NonNullable<Config["telegram"]>;

/** One update of the Bot API: `chat` is "" when it is not a message; `text` is null for a non-text one. */
export interface TelegramUpdate {
  id: number;
  chat: string;
  text: string | null;
  /** TG-6: the message this one replies to. */
  replyTo?: number;
  /** TG-3: a pressed inline button (`id` answers it, `message` is the message it sits on). */
  callback?: { id: string; data: string; message: number };
}

/** At most `MAX_TEXT` characters, cut with an ellipsis. */
function cut(text: string): string {
  const chars = [...text];
  return chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join("")}…` : text;
}

/** `html`: the text is HTML (TG-17's `<pre>` block); `replyTo`: a message to reply to (TG-20's ping). */
export interface SendOptions {
  /** USR-11: a linked person's chat; absent, the owner's. */
  chat?: string;
  html?: boolean;
  replyTo?: number;
}

const markup = (rows: Button[][]) => rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data })));

export class Telegram implements Sender {
  private config: TelegramConfig;
  private http: Http;
  private log: (line: string) => void;
  /** A failure was logged and nothing has worked since. */
  private down = false;
  /** The same for `getUpdates`. */
  private pollDown = false;

  constructor(config: TelegramConfig, http: Http = fetchHttp, log: (line: string) => void = emit) {
    this.config = config;
    this.http = http;
    this.log = log;
  }

  /**
   * `POST <api_base>/bot<token>/sendMessage` `{chat_id, text, disable_web_page_preview: true}` (with
   * `reply_markup` when there are buttons); sent = HTTP 200 and `ok: true`. Resolves with the message id.
   * Rejects with a reason that never holds the token.
   */
  async send(text: string, buttons?: Button[][], opts: SendOptions = {}): Promise<number | undefined> {
    const body = {
      chat_id: opts.chat ?? this.config.chatId,
      text: cut(text),
      disable_web_page_preview: true,
      ...(opts.html ? { parse_mode: "HTML" } : {}),
      ...(opts.replyTo
        ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } }
        : {}),
      ...(buttons?.length ? { reply_markup: { inline_keyboard: markup(buttons) } } : {}),
    };
    const v = await this.call("sendMessage", body);
    const id = (v.result as { message_id?: unknown } | undefined)?.message_id;
    return typeof id === "number" ? id : undefined;
  }

  /** LOOP-128: `editMessageText`; no buttons removes them. Telegram refusing the edit rejects with `Refused`. */
  async edit(message: number, text: string, buttons?: Button[][], opts: SendOptions = {}): Promise<void> {
    try {
      await this.call(
        "editMessageText",
        {
          chat_id: opts.chat ?? this.config.chatId,
          message_id: message,
          text: cut(text),
          disable_web_page_preview: true,
          ...(opts.html ? { parse_mode: "HTML" } : {}),
          reply_markup: { inline_keyboard: markup(buttons ?? []) },
        },
        true,
      );
    } catch (e) {
      // TG-22: "message is not modified" means the message already says it.
      if (e instanceof Refused && /not modified/i.test(e.message)) return;
      throw e;
    }
  }

  /** TG-20: `deleteMessage`. Telegram refusing (gone, too old) rejects with `Refused`. */
  async remove(message: number, chat?: string): Promise<void> {
    await this.call("deleteMessage", { chat_id: chat ?? this.config.chatId, message_id: message }, true);
  }

  /** TG-5: `answerCallbackQuery`, so the button stops spinning. */
  async answer(callback: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callback, text: text.slice(0, 200) }, true);
  }

  /** One Bot API call. `refusable`: an HTTP 400 (message gone, too old, unchanged) is `Refused`, not a failure. */
  private async call(method: string, body: object, refusable = false): Promise<{ result?: unknown }> {
    let why: string | null = null;
    let v: { ok?: unknown; description?: unknown; result?: unknown } = {};
    let status = 0;
    try {
      const r = await this.http({
        method: "POST",
        url: `${this.config.apiBase}/bot${this.config.botToken}/${method}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: TELEGRAM_TIMEOUT_MS,
      });
      status = r.status;
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
      return v;
    }
    const msg = `telegram ${method}: ${this.mask(why)}`;
    if (refusable && status === 400) throw new Refused(msg);
    if (!this.down) {
      this.down = true;
      this.log(msg);
    }
    throw new Error(msg);
  }

  /**
   * LOOP-129, LOOP-127: `GET <api_base>/bot<token>/getUpdates?offset=<offset>&timeout=<seconds>`; the new
   * updates in order (messages and button presses).
   * Rejects with a reason that never holds the token; logged once per outage.
   */
  async updates(offset: number, timeoutSec = 0): Promise<TelegramUpdate[]> {
    let why: string | null = null;
    const out: TelegramUpdate[] = [];
    try {
      const r = await this.http({
        method: "GET",
        url: `${this.config.apiBase}/bot${this.config.botToken}/getUpdates?offset=${offset}&timeout=${timeoutSec}&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`,
        timeoutMs: TELEGRAM_TIMEOUT_MS + timeoutSec * 1000,
      });
      let v: { ok?: unknown; description?: unknown; result?: unknown } = {};
      try {
        v = JSON.parse(r.text) as typeof v;
      } catch {
        // Not JSON: a proxy's error page.
      }
      if (r.status !== 200 || v.ok !== true || !Array.isArray(v.result)) {
        why = `HTTP ${r.status}: ${typeof v.description === "string" ? v.description : "ok is not true"}`;
      } else {
        for (const u of v.result as Record<string, unknown>[]) {
          const id = u.update_id;
          if (typeof id !== "number") continue;
          const q = u.callback_query as
            | { id?: unknown; data?: unknown; message?: { message_id?: unknown; chat?: { id?: unknown } } }
            | undefined;
          if (q) {
            const c = q.message?.chat?.id;
            out.push({
              id,
              chat: c === undefined ? "" : String(c),
              text: null,
              callback: {
                id: String(q.id ?? ""),
                data: typeof q.data === "string" ? q.data : "",
                message: Number(q.message?.message_id) || 0,
              },
            });
            continue;
          }
          const m = (u.message ?? {}) as {
            chat?: { id?: unknown };
            text?: unknown;
            reply_to_message?: { message_id?: unknown };
          };
          const to = m.reply_to_message?.message_id;
          out.push({
            id,
            chat: m.chat?.id === undefined ? "" : String(m.chat.id),
            text: typeof m.text === "string" ? m.text : null,
            ...(typeof to === "number" ? { replyTo: to } : {}),
          });
        }
      }
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    if (why === null) {
      this.pollDown = false;
      return out;
    }
    const msg = `telegram getUpdates: ${this.mask(why)}`;
    if (!this.pollDown) {
      this.pollDown = true;
      this.log(msg);
    }
    throw new Error(msg);
  }

  private mask(s: string): string {
    return s.replaceAll(this.config.botToken, "<token>").replace(/\s+/g, " ").trim();
  }
}
