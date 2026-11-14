// Each person's own Telegram chat (USR-11, USR-12): a one-time code ties a chat to a person, a linked
// chat gets only the waits that are for that person, and what it presses or replies follows the person's
// role. The owner's chat keeps going through `Chat` untouched.

import { createHash, randomInt } from "node:crypto";
import { A0_ADMIN_ONLY } from "../autonomy.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock } from "../handlers.ts";
import type { Button } from "../outbox.ts";
import type { SendOptions, TelegramUpdate } from "../telegram.ts";
import type { Actor, UiActions } from "../ui/actions.ts";
import { getUser, record } from "../users/store.ts";
import { recordWriter, writerOf } from "../users/writer.ts";
import { can, denial, type User } from "../users.ts";
import type { ChatData } from "./chat.ts";
import {
  cardLink,
  confirmButtons,
  confirmText,
  decode,
  endedText,
  type WaitView,
  waitButtons,
  waitText,
} from "./render.ts";

/** USR-11: a code lives 10 minutes and works once. */
export const CODE_TTL_S = 600;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const hash = (code: string) => createHash("sha256").update(code.trim().toUpperCase()).digest("hex");

/** A fresh one-time code for `login`; an earlier unused one stops working. */
export function newLinkCode(db: Db, login: string, now: number): string {
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  db.tx(() => {
    db.run("DELETE FROM link_codes WHERE login = ? AND used_at IS NULL", login.toLowerCase());
    db.run(
      "INSERT INTO link_codes (code_hash, login, expires) VALUES (?, ?, ?)",
      hash(code),
      login.toLowerCase(),
      now + CODE_TTL_S,
    );
  });
  return code;
}

/** The person a code links `chat` to, or null when it is wrong, used, expired or its person is gone. One chat per person. */
export function redeemLinkCode(db: Db, code: string, chat: string, now: number): string | null {
  return db.tx(() => {
    const row = db.get<{ login: string }>(
      "SELECT login FROM link_codes WHERE code_hash = ? AND used_at IS NULL AND expires > ?",
      hash(code),
      now,
    );
    if (!row) return null;
    db.run("UPDATE link_codes SET used_at = ? WHERE code_hash = ?", now, hash(code));
    const person = getUser(db, row.login);
    if (!person || person.disabled) return null;
    db.run("UPDATE users SET telegram_chat = NULL WHERE telegram_chat = ?", chat);
    db.run("UPDATE users SET telegram_chat = ? WHERE login = ?", chat, row.login);
    record(db, now, row.login, "link", row.login, "telegram");
    return row.login;
  });
}

export function unlinkTelegram(db: Db, login: string, now: number): void {
  db.run("UPDATE users SET telegram_chat = NULL WHERE login = ?", login.toLowerCase());
  record(db, now, login.toLowerCase(), "unlink", login.toLowerCase(), "telegram");
}

/** The enabled person whose linked chat this is. */
export function personOfChat(db: Db, chat: string): (User & { name: string }) | null {
  if (!chat) return null;
  const r = db.get<{ login: string }>(
    "SELECT login FROM users WHERE telegram_chat = ? AND disabled_at IS NULL",
    chat,
  );
  const p = r ? getUser(db, r.login) : null;
  return p ? { ...p, name: p.name || p.login } : null;
}

/** USR-12: who a wait is sent to. A viewer gets nothing; a contributor only questions on intents they wrote. */
export function receives(
  user: User,
  v: Pick<WaitView, "repo" | "question" | "onlyYou" | "intent">,
  writer: string | null,
): boolean {
  if (v.onlyYou) return user.role === "admin";
  if (can(user, "approve", v.repo)) return true;
  return v.question && writer === user.login && can(user, "answer", v.repo);
}

const OPS: Record<string, "merge" | "drop" | "retry"> = {
  m: "merge",
  M: "merge",
  d: "drop",
  D: "drop",
  r: "retry",
};

export interface PeopleApi {
  send(text: string, buttons?: Button[][], opts?: SendOptions): Promise<number | undefined>;
  edit(message: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<void>;
  answer(callback: string, text: string): Promise<void>;
}

export interface PeopleDeps {
  config: Config;
  db: Db;
  clock: Clock;
  log(line: string): void;
  telegram: PeopleApi;
  actions: UiActions;
  data: Pick<ChatData, "waits">;
  /** `/add <repo>: <title>`: a new intent in the intents repo. */
  addIntent?(repo: string, title: string): Promise<{ id: string }>;
}

interface CopyRow {
  mission: number;
  chat: string;
  message_id: number | null;
  text: string;
  buttons: string | null;
  wait: string | null;
  decided_by: string | null;
}

export class PeopleChat {
  private d: PeopleDeps;

  constructor(d: PeopleDeps) {
    this.d = d;
  }

  /** Whether the chat takes this update for itself: a linked chat, or anyone sending `/link <code>`. */
  static accepts(db: Db, u: TelegramUpdate): boolean {
    return personOfChat(db, u.chat) !== null || /^\/link(@\w+)?\s+\S+/.test(u.text ?? "");
  }

  async pass(): Promise<void> {
    const { db } = this.d;
    for (const r of db.all<{ update_id: number; data: string }>(
      "SELECT update_id, data FROM telegram_updates WHERE state = 'people' ORDER BY update_id",
    )) {
      db.run("UPDATE telegram_updates SET state = 'done' WHERE update_id = ?", r.update_id);
      try {
        await this.handle(JSON.parse(r.data) as TelegramUpdate);
      } catch (e) {
        this.d.log(`telegram: update ${r.update_id}: ${(e as Error).message}`);
      }
    }
    await this.sync().catch((e: Error) => this.d.log(`telegram: people: ${e.message}`));
  }

  private say(chat: string, text: string): Promise<number | undefined> {
    return this.d.telegram.send(text, undefined, { chat });
  }

  private actor(p: User & { name: string }): Actor {
    return { login: p.login, name: p.name, via: "telegram", signed: true };
  }

  private async handle(u: TelegramUpdate): Promise<void> {
    const { db, clock } = this.d;
    const link = /^\/link(?:@\w+)?\s+(\S+)/.exec(u.text?.trim() ?? "");
    if (link) {
      const login = redeemLinkCode(db, link[1]!, u.chat, clock.now());
      await this.say(
        u.chat,
        login
          ? `Linked: this chat is now ${login}'s. You get what waits on you here.`
          : "That code doesn't work: it may be used, expired or wrong. Ask for a new one on the page.",
      );
      return;
    }
    const person = personOfChat(db, u.chat);
    if (!person) return;
    if (u.callback) return this.press(u, u.callback, person);
    const text = u.text?.trim();
    if (!text) return;
    if (u.replyTo && !text.startsWith("/")) return this.reply(u, text, u.replyTo, person);
    // USR-1, AUT-23: a contributor or above adds an intent; the person behind the chat is its writer.
    const add = /^\/add(?:@\w+)?\s+([A-Za-z0-9._-]+):\s*(.+)$/s.exec(text);
    if (add && this.d.addIntent) {
      const why = denial(person, "create", add[1]);
      if (why) return void (await this.say(u.chat, why));
      const made = await this.d.addIntent(add[1]!, add[2]!.trim());
      recordWriter(this.d.db, made.id, { login: person.login, via: "telegram" });
      return void (await this.say(u.chat, `Added ${made.id} in ${add[1]}.`));
    }
    await this.say(u.chat, "Reply to a question to answer it, or use its buttons.");
  }

  private copyOf(chat: string, message: number): CopyRow | undefined {
    return this.d.db.get<CopyRow>(
      "SELECT * FROM tg_card_chats WHERE chat = ? AND message_id = ?",
      chat,
      message,
    );
  }

  private async press(
    u: TelegramUpdate,
    cb: NonNullable<TelegramUpdate["callback"]>,
    person: User & { name: string },
  ) {
    const t = this.d.telegram;
    const p = decode(cb.data);
    const row = this.copyOf(u.chat, cb.message);
    if (!p || !row) return t.answer(cb.id, "That button is not valid.");
    const v = (await this.d.data.waits()).find((x) => x.intent === p.a);
    if (!v || v.waitId !== p.b || row.wait !== p.b) {
      await t.answer(cb.id, "That is already handled.");
      return this.sync();
    }
    if (p.op === "x") {
      await t.answer(cb.id, "Cancelled.");
      return t.edit(cb.message, row.text, row.buttons ? (JSON.parse(row.buttons) as Button[][]) : [], {
        chat: u.chat,
        html: row.text.startsWith("<pre>"),
      });
    }
    const action = OPS[p.op];
    if (!action) return t.answer(cb.id, "That button is not valid.");
    // USR-11: what a chat may do is what the person's role allows on this repo.
    const no =
      denial(person, action, v.repo) ?? (v.onlyYou && person.role !== "admin" ? A0_ADMIN_ONLY : null);
    if (no) return t.answer(cb.id, no);
    if (!v.actions.includes(action) || (v.question && action !== "drop")) {
      return t.answer(cb.id, "That is not offered here.");
    }
    if (p.op === "m" || p.op === "d") {
      const op = p.op === "m" ? "M" : "D";
      await t.answer(cb.id, op === "M" ? "Tap Yes to merge." : "Tap Yes to drop.");
      return t.edit(cb.message, confirmText(op, v), confirmButtons(op, v), { chat: u.chat });
    }
    const acts = this.d.actions.as?.(this.actor(person)) ?? this.d.actions;
    try {
      const said = await (action === "merge"
        ? acts.merge(v.intent)
        : action === "drop"
          ? acts.drop(v.intent)
          : acts.retry(v.intent));
      this.decided(row.mission, row.wait, person.login);
      await t.answer(cb.id, said);
      await this.sync();
    } catch (e) {
      await t.answer(cb.id, (e as Error).message);
    }
  }

  private async reply(u: TelegramUpdate, text: string, to: number, person: User & { name: string }) {
    const row = this.copyOf(u.chat, to);
    if (!row?.wait) return;
    const v = (await this.d.data.waits()).find((x) => x.waitId === row.wait);
    if (!v) return void (await this.say(u.chat, "That is already handled."));
    const mine = writerOf(this.d.db, v.intent)?.login === person.login && can(person, "answer", v.repo);
    const why =
      v.onlyYou && person.role !== "admin"
        ? A0_ADMIN_ONLY
        : v.question && mine
          ? null
          : denial(person, "reply", v.repo);
    if (why) return void (await this.say(u.chat, why));
    const acts = this.d.actions.as?.(this.actor(person)) ?? this.d.actions;
    try {
      const said = await acts.reply(v.intent, text);
      this.decided(row.mission, row.wait, person.login);
      await this.say(u.chat, said);
      await this.sync();
    } catch (e) {
      await this.say(u.chat, (e as Error).message);
    }
  }

  private decided(mission: number, wait: string, login: string): void {
    this.d.db.run(
      "UPDATE tg_card_chats SET decided_by = ? WHERE mission = ? AND wait = ?",
      login,
      mission,
      wait,
    );
  }

  /** USR-12: send each linked person the waits for them; edit the copies of a wait that is over, naming who decided. */
  async sync(): Promise<void> {
    const { db, config } = this.d;
    const owner = config.telegram?.chatId ?? "";
    const views = await this.d.data.waits();
    const people = db
      .all<{ login: string }>(
        "SELECT login FROM users WHERE telegram_chat IS NOT NULL AND disabled_at IS NULL",
      )
      .map((r) =>
        personOfChat(
          db,
          db.get<{ telegram_chat: string }>("SELECT telegram_chat FROM users WHERE login = ?", r.login)!
            .telegram_chat,
        ),
      )
      .filter((p): p is User & { name: string } => p !== null);
    const live = new Set<string>();
    for (const v of views) {
      const mission = Number(v.waitId.split(".")[0]);
      for (const p of people) {
        const chat = db.get<{ telegram_chat: string }>(
          "SELECT telegram_chat FROM users WHERE login = ?",
          p.login,
        )!.telegram_chat;
        if (chat === owner || !receives(p, v, writerOf(db, v.intent)?.login ?? null)) continue;
        live.add(`${mission}:${chat}`);
        const acts = !v.onlyYou && can(p, "approve", v.repo);
        const text = waitText(v, cardLink(config.telegram, v.intent, v.pr?.url ?? null));
        const buttons = acts ? waitButtons(v) : [];
        const json = buttons.length ? JSON.stringify(buttons) : null;
        const row = db.get<CopyRow>(
          "SELECT * FROM tg_card_chats WHERE mission = ? AND chat = ?",
          mission,
          chat,
        );
        if (!row || row.wait !== v.waitId) {
          const id = await this.d.telegram.send(text, buttons, { chat });
          db.run(
            "INSERT INTO tg_card_chats (mission, chat, message_id, text, buttons, wait) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(mission, chat) DO UPDATE SET message_id = excluded.message_id, text = excluded.text, buttons = excluded.buttons, wait = excluded.wait, decided_by = NULL",
            mission,
            chat,
            id ?? null,
            text,
            json,
            v.waitId,
          );
        } else if (row.message_id !== null && (row.text !== text || row.buttons !== json)) {
          await this.d.telegram.edit(row.message_id, text, buttons, { chat });
          db.run(
            "UPDATE tg_card_chats SET text = ?, buttons = ? WHERE mission = ? AND chat = ?",
            text,
            json,
            mission,
            chat,
          );
        }
      }
    }
    for (const row of db.all<CopyRow>("SELECT * FROM tg_card_chats WHERE wait IS NOT NULL")) {
      if (live.has(`${row.mission}:${row.chat}`) || row.message_id === null) continue;
      const who =
        row.decided_by ??
        db.get<{ actor: string }>(
          "SELECT actor FROM transitions WHERE mission = ? AND actor IS NOT NULL AND actor != 'towercab' ORDER BY id DESC LIMIT 1",
          row.mission,
        )?.actor ??
        null;
      const text = endedText(row.text, who ? `✅ handled by ${getUser(db, who)?.name || who}` : "✅ handled");
      await this.d.telegram.edit(row.message_id, text, [], { chat: row.chat });
      db.run(
        "UPDATE tg_card_chats SET text = ?, buttons = NULL, wait = NULL WHERE mission = ? AND chat = ?",
        text,
        row.mission,
        row.chat,
      );
    }
  }
}
