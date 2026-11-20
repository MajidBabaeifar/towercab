// The copies of an intent's card in linked people's chats (USR-12): sent when something waits on that
// person, edited as it changes, and edited "handled by <name>" when anyone decides. The owner's own card
// stays in `cards.ts`; these rows are in `tg_person_cards`.

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock } from "../handlers.ts";
import { type Button, Refused } from "../outbox.ts";
import type { SendOptions } from "../telegram.ts";
import { can } from "../users.ts";
import { getUser } from "../users-store.ts";
import type { CardItem } from "./cards.ts";
import { recipientsOf } from "./people.ts";
import { cardLink, firstLine, waitButtons, waitText } from "./render.ts";

export interface PersonApi {
  send(text: string, buttons?: Button[][], opts?: SendOptions): Promise<number | undefined>;
  edit(message: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<void>;
}

export interface PersonRow {
  mission: number;
  login: string;
  chat: string;
  intent: string;
  message_id: number | null;
  text: string;
  buttons: string | null;
  wait: string | null;
  final: number;
  handled_by: string | null;
}

export interface PersonDeps {
  config: Config;
  db: Db;
  log(line: string): void;
  telegram: PersonApi;
  clock?: Clock;
}

/** One pass touches at most this many copies (Telegram allows about one message a second to a chat). */
const MAX_PER_PASS = 10;
const GONE = /not found|can't be edited|too old|message_id_invalid/i;

export class PersonCards {
  private d: PersonDeps;
  private failing = new Set<string>();

  constructor(d: PersonDeps) {
    this.d = d;
  }

  /** The copy in `chat` with this Telegram message id. */
  byMessage(chat: string, message: number): PersonRow | undefined {
    return this.d.db.get<PersonRow>(
      "SELECT * FROM tg_person_cards WHERE chat = ? AND message_id = ?",
      chat,
      message,
    );
  }

  async sync(items: CardItem[]): Promise<void> {
    const { db } = this.d;
    const ownerChat = this.d.config.telegram?.chatId ?? "";
    const wanted = new Set<string>();
    let ops = 0;
    for (const { view, wait } of items) {
      if (!wait || view.final || view.ask === null) continue;
      for (const r of recipientsOf(db, { ...wait, intent: view.intent }, ownerChat)) {
        const k = `${view.mission}:${r.user.login.toLowerCase()}`;
        wanted.add(k);
        if (ops >= MAX_PER_PASS) continue;
        try {
          if (await this.one(r.user.login.toLowerCase(), r.chat, view.mission, view.link, wait, r.user))
            ops++;
          this.failing.delete(k);
        } catch (e) {
          if (!this.failing.has(k)) {
            this.failing.add(k);
            this.d.log(`telegram: copy for ${r.user.login} of ${view.intent}: ${(e as Error).message}`);
          }
        }
      }
    }
    for (const row of db.all<PersonRow>("SELECT * FROM tg_person_cards WHERE final = 0")) {
      if (wanted.has(`${row.mission}:${row.login}`)) continue;
      if (ops >= MAX_PER_PASS) return;
      try {
        await this.close(row, row.handled_by ?? this.lastActor(row.mission));
        ops++;
      } catch (e) {
        this.d.log(`telegram: copy for ${row.login} of ${row.intent}: ${(e as Error).message}`);
      }
    }
  }

  /** USR-12: every open copy of this wait says who handled it. */
  async handled(intent: string, wait: string, by: string): Promise<void> {
    for (const row of this.d.db.all<PersonRow>(
      "SELECT * FROM tg_person_cards WHERE intent = ? AND wait = ? AND final = 0",
      intent,
      wait,
    )) {
      try {
        await this.close(row, by);
      } catch (e) {
        this.d.log(`telegram: copy for ${row.login} of ${intent}: ${(e as Error).message}`);
      }
    }
  }

  private async one(
    login: string,
    chat: string,
    mission: number,
    link: string | null,
    wait: NonNullable<CardItem["wait"]>,
    user: NonNullable<ReturnType<typeof getUser>>,
  ): Promise<boolean> {
    const { db, telegram } = this.d;
    // The buttons are the actions this person's role allows on the repo.
    const mine = { ...wait, actions: wait.actions.filter((a) => can(user, a, wait.repo)) };
    const text = waitText(mine, cardLink(this.d.config.telegram, wait.intent, link));
    const buttons = waitButtons(mine);
    const json = buttons.length ? JSON.stringify(buttons) : null;
    const row = db.get<PersonRow>(
      "SELECT * FROM tg_person_cards WHERE mission = ? AND login = ?",
      mission,
      login,
    );
    if (row && row.final === 1 && row.wait === wait.waitId) return false;
    if (!row || row.final === 1 || row.message_id === null || row.wait !== wait.waitId) {
      // A first copy, or a new ask on this mission: a new message.
      const id = await telegram.send(text, buttons, { chat });
      if (typeof id !== "number") throw new Error("Telegram sent the message but gave no message id");
      db.run(
        `INSERT INTO tg_person_cards (mission, login, chat, intent, message_id, text, buttons, wait, final)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (mission, login) DO UPDATE SET chat = excluded.chat, message_id = excluded.message_id,
           text = excluded.text, buttons = excluded.buttons, wait = excluded.wait, final = 0, handled_by = NULL`,
        mission,
        login,
        chat,
        wait.intent,
        id,
        text,
        json,
        wait.waitId,
      );
      return true;
    }
    if (text === row.text && json === row.buttons && chat === row.chat) return false;
    try {
      await telegram.edit(row.message_id, text, buttons, { chat: row.chat });
    } catch (e) {
      if (!(e instanceof Refused) || !GONE.test(e.message)) throw e;
      db.run("UPDATE tg_person_cards SET message_id = NULL WHERE mission = ? AND login = ?", mission, login);
      return true;
    }
    db.run(
      "UPDATE tg_person_cards SET text = ?, buttons = ? WHERE mission = ? AND login = ?",
      text,
      json,
      mission,
      login,
    );
    return true;
  }

  private async close(row: PersonRow, by: string): Promise<void> {
    const text = `${firstLine(row.text)}\n✅ handled by ${by}`;
    if (row.message_id !== null) {
      try {
        await this.d.telegram.edit(row.message_id, text, [], { chat: row.chat });
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
      }
    }
    this.d.db.run(
      "UPDATE tg_person_cards SET text = ?, buttons = NULL, final = 1, handled_by = ? WHERE mission = ? AND login = ?",
      text,
      by,
      row.mission,
      row.login,
    );
  }

  /** Who made the mission's last move: a person's name, else Towercab. */
  private lastActor(mission: number): string {
    const { db } = this.d;
    const t = db.get<{ actor: string }>(
      "SELECT actor FROM transitions WHERE mission = ? ORDER BY id DESC LIMIT 1",
      mission,
    );
    if (!t?.actor || t.actor === "towercab") return "Towercab";
    return getUser(db, t.actor)?.name || t.actor;
  }
}
