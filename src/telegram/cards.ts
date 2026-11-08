// The intent cards (TG-16..TG-22): one Telegram message per mission, sent when the intent first needs the
// owner, edited as it moves, pinged when it turns into a needs-you wait, frozen when it ends, replaced when
// Telegram will not edit it. `sync` compares what the page knows with what each card last showed.

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock } from "../handlers.ts";
import { envBackoff } from "../machine.ts";
import { type Button, Refused } from "../outbox.ts";
import type { SendOptions } from "../telegram.ts";
import { type CardView, cardText, pingText } from "./card.ts";
import { cardLink, type WaitView, waitButtons } from "./render.ts";

/** The Bot API calls the cards make (`Telegram`; tests give it a fake HTTP). */
export interface CardApi {
  send(text: string, buttons?: Button[][], opts?: SendOptions): Promise<number | undefined>;
  edit(message: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<void>;
  remove(message: number): Promise<void>;
}

/** One card to keep up to date: what it shows, and the wait whose buttons it carries. */
export interface CardItem {
  view: CardView;
  wait: WaitView | null;
}

/** A row of `tg_cards`. */
export interface CardRow {
  mission: number;
  intent: string;
  message_id: number | null;
  text: string;
  buttons: string | null;
  ping_id: number | null;
  ping_wait: string | null;
  final: number;
  tries: number;
  next_try: number;
}

export interface CardsDeps {
  config: Config;
  db: Db;
  clock: Clock;
  log(line: string): void;
  telegram: CardApi;
}

/** One pass touches at most this many cards (Telegram allows about one message a second to a chat). */
const MAX_PER_PASS = 10;
/** TG-22: what Telegram says when the message is gone or too old to edit. */
const GONE = /not found|can't be edited|too old|message_id_invalid/i;

export class Cards {
  private d: CardsDeps;
  /** Cards whose failure was logged and which have not worked since. */
  private failing = new Set<number>();

  constructor(d: CardsDeps) {
    this.d = d;
  }

  /** The card whose message, or ping, has this Telegram id. */
  byMessage(message: number): CardRow | undefined {
    return this.d.db.get<CardRow>(
      "SELECT * FROM tg_cards WHERE message_id = ? OR ping_id = ?",
      message,
      message,
    );
  }

  /** The card no longer shows what was stored (a confirm replaced it): the next sync edits it again. */
  invalidate(intent: string): void {
    this.d.db.run("UPDATE tg_cards SET text = '' WHERE intent = ? AND final = 0", intent);
  }

  /** The card's buttons for the wait it shows (TG-19): none when nothing is asked, or the intent is owner-only. */
  static buttons(v: CardView, wait: WaitView | null): Button[][] {
    return v.final || v.ask === null || !wait ? [] : waitButtons(wait);
  }

  /** The text and buttons the card should show now. */
  private shown(v: CardView, wait: WaitView | null): { text: string; buttons: Button[][] } {
    const link = cardLink(this.d.config.telegram, v.intent, v.link);
    return { text: cardText({ ...v, link }), buttons: Cards.buttons(v, wait) };
  }

  async sync(items: CardItem[]): Promise<void> {
    let ops = 0;
    for (const { view, wait } of items) {
      if (ops >= MAX_PER_PASS) return;
      try {
        if (await this.one(view, wait)) ops++;
      } catch (e) {
        this.fail(view.mission, e);
      }
    }
  }

  private fail(mission: number, e: unknown): void {
    const { db, clock, log } = this.d;
    const row = db.get<CardRow>("SELECT * FROM tg_cards WHERE mission = ?", mission);
    if (row)
      db.run(
        "UPDATE tg_cards SET tries = ?, next_try = ? WHERE mission = ?",
        row.tries + 1,
        clock.now() + envBackoff(row.tries),
        mission,
      );
    if (!this.failing.has(mission)) {
      this.failing.add(mission);
      log(`telegram: card ${row?.intent ?? mission}: ${(e as Error).message}`);
    }
  }

  /** Brings one card up to date; true when it called Telegram. */
  private async one(v: CardView, wait: WaitView | null): Promise<boolean> {
    const { db, clock } = this.d;
    const needs = v.ask !== null && !v.final;
    let row = db.get<CardRow>("SELECT * FROM tg_cards WHERE mission = ?", v.mission);
    // A card appears when the intent first needs the owner, or ends without being verified (TG-16).
    if (!row) {
      if (!needs && !v.final?.startsWith("⚠")) return false;
      db.run("INSERT INTO tg_cards (mission, intent) VALUES (?, ?)", v.mission, v.intent);
      row = db.get<CardRow>("SELECT * FROM tg_cards WHERE mission = ?", v.mission)!;
    }
    if (row.final === 1) return false;
    if (row.next_try > clock.now()) return false;

    const { text, buttons } = this.shown(v, wait);
    const json = buttons.length ? JSON.stringify(buttons) : null;

    if (row.message_id === null) {
      // The card's own send already notifies the phone: no ping with it (TG-20).
      await this.place(row, v, text, json, buttons, needs ? (v.waitId ?? null) : null);
      return true;
    }

    let called = false;
    let current = row;
    if (text !== row.text || json !== row.buttons) {
      called = true;
      try {
        await this.d.telegram.edit(row.message_id, text, buttons, { html: true });
        db.run(
          "UPDATE tg_cards SET text = ?, buttons = ?, tries = 0, next_try = 0 WHERE mission = ?",
          text,
          json,
          v.mission,
        );
        this.failing.delete(v.mission);
      } catch (e) {
        if (!(e instanceof Refused) || !GONE.test(e.message)) throw e;
        // TG-22: gone or too old: a new card, and its id in place of the old one.
        this.d.log(`telegram: card ${v.intent} cannot be edited (${e.message}); sent again`);
        await this.place(row, v, text, json, buttons, null);
      }
      current = db.get<CardRow>("SELECT * FROM tg_cards WHERE mission = ?", v.mission)!;
    }

    if (v.final) {
      await this.dropPing(current);
      db.run("UPDATE tg_cards SET final = 1 WHERE mission = ?", v.mission);
      return true;
    }
    return (await this.ping(current, v, needs)) || called;
  }

  /** Sends the card as a new message and records its id (first send, or a replacement). */
  private async place(
    row: CardRow,
    v: CardView,
    text: string,
    json: string | null,
    buttons: Button[][],
    pinged: string | null,
  ): Promise<void> {
    const id = await this.d.telegram.send(text, buttons, { html: true });
    if (typeof id !== "number") throw new Error("Telegram sent the card but gave no message id");
    this.d.db.run(
      "UPDATE tg_cards SET message_id = ?, text = ?, buttons = ?, ping_wait = ?, tries = 0, next_try = 0, final = ? WHERE mission = ?",
      id,
      text,
      json,
      pinged,
      v.final ? 1 : 0,
      row.mission,
    );
    this.failing.delete(v.mission);
    // The old card's ping answers a card that is gone; the replacement is pinged again below.
    if (row.message_id !== null) {
      await this.dropPing(row);
      this.d.db.run("UPDATE tg_cards SET ping_wait = NULL WHERE mission = ?", row.mission);
    }
  }

  /** TG-20: a ping on the change into a needs-you wait; the old ping goes when its wait is over. */
  private async ping(row: CardRow, v: CardView, needs: boolean): Promise<boolean> {
    const { db } = this.d;
    const wait = needs ? (v.waitId ?? "") : null;
    if (wait === row.ping_wait) return false;
    if (row.ping_id !== null) await this.dropPing(row);
    if (wait === null || row.message_id === null) {
      db.run("UPDATE tg_cards SET ping_wait = NULL WHERE mission = ?", row.mission);
      return true;
    }
    const id = await this.d.telegram.send(pingText(v), undefined, { replyTo: row.message_id });
    db.run(
      "UPDATE tg_cards SET ping_id = ?, ping_wait = ? WHERE mission = ?",
      typeof id === "number" ? id : null,
      wait,
      row.mission,
    );
    return true;
  }

  /** Deletes the ping; Telegram refusing (gone, too old) is dropped and logged once. */
  private async dropPing(row: CardRow): Promise<void> {
    if (row.ping_id === null) return;
    try {
      await this.d.telegram.remove(row.ping_id);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      this.d.log(`telegram: ping of ${row.intent} cannot be deleted (${e.message})`);
    }
    this.d.db.run("UPDATE tg_cards SET ping_id = NULL WHERE mission = ?", row.mission);
  }
}
