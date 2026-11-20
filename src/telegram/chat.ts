// The owner's side of Telegram (TG-1..15, LOOP-126..128): updates in, buttons, replies and commands handled
// through the page's own actions, messages edited when their wait is handled. `Chat` is the only reader of
// `getUpdates`; each update is stored before the offset moves past it, then handled once in a loop pass.

import { type Actor, ownerActor, runAs } from "../actor.ts";
import { ownerOnlyLine } from "../autonomy.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Clock } from "../handlers.ts";
import { peopleOf } from "../intent-people.ts";
import { envBackoff, finished } from "../machine.ts";
import { getMission, unfinishedFor } from "../mission.ts";
import type { Button, OutboxRow, Sender } from "../outbox.ts";
import { OFFSET, offset, statusText } from "../shadow/store.ts";
import type { SendOptions, TelegramUpdate } from "../telegram.ts";
import type { UiActions } from "../ui/actions.ts";
import { can, refusal, roleOn, type UserAction } from "../users.ts";
import { getUser, type StoredUser } from "../users-store.ts";
import { type CardItem, type CardRow, Cards } from "./cards.ts";
import { linkedUser, redeemLinkCode } from "./people.ts";
import { PersonCards, type PersonRow } from "./person-cards.ts";
import {
  cardLink,
  closeConfirmText,
  confirmButtons,
  confirmText,
  decode,
  endedText,
  type ProposalView,
  proposalButtons,
  proposalText,
  REPLY_LINE,
  type WaitView,
  waitButtons,
  waitText,
  withLink,
} from "./render.ts";

/** What the page knows, as the chat needs it (the loop's wiring fills it from `src/ui/`). */
export interface ChatData {
  waits(): Promise<WaitView[]>;
  proposals(): Promise<ProposalView[]>;
  /** UI-193's pick (the Inbox's first item), with the number of other waits. */
  focus(): Promise<{ wait: WaitView | null; proposal: ProposalView | null; more: number }>;
  queue(): Promise<{ title: string; repo: string; state: string }[]>;
  running(): Promise<{ intent: string; title: string; step: string }[]>;
  /** The live head of the intent's current PR, or null. */
  prHead(intent: string): Promise<string | null>;
  /** TG-16: the cards to keep up to date: every unfinished mission, and the ended ones whose card is open. */
  cards(): Promise<CardItem[]>;
  /** USR-11: the repo of an intent that is not running yet (a held one), for `/confirm`. */
  repoOf?(intent: string): Promise<string | null>;
}

/** The Bot API calls the chat makes (`Telegram`; tests give it a fake HTTP). */
export interface ChatApi {
  updates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  send(text: string, buttons?: Button[][], opts?: SendOptions): Promise<number | undefined>;
  edit(message: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<void>;
  remove(message: number, chat?: string): Promise<void>;
  answer(callback: string, text: string): Promise<void>;
}

export interface ChatDeps {
  config: Config;
  db: Db;
  clock: Clock;
  log(line: string): void;
  telegram: ChatApi;
  actions: UiActions;
  data: ChatData;
  /** Seconds between looks at the sent messages (default 10). */
  sweepEvery?: number;
  /** Waits for the long poll's retry; stopped with the chat. Tests give none and never start the poll. */
  sleep?: (ms: number) => Promise<void>;
}

/** Who sent the update being handled: the owner's chat, a linked person's, or a chat nobody linked. */
interface Who {
  chat: string;
  user: StoredUser | null;
}

const PUBLIC_HELP =
  "I understand /status, /focus, /queue, /pause, /resume and /fast. Reply to a question to answer it.";
const MAX_LINES = 10;
/** USR-11: `/link <code>` (or Telegram's `/start <code>`) from a chat that is not linked yet. */
const LINK = /^\/(?:link|start)(?:@\w+)?\s+\S+/i;
const POLL_SECONDS = 25;

const trim = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export class Chat {
  private d: ChatDeps;
  private poller: Promise<void> | null = null;
  private stopped = false;
  private lastSweep = Number.NEGATIVE_INFINITY;
  private lastCards = Number.NEGATIVE_INFINITY;
  private cards: Cards;
  private people: PersonCards;
  private who: Who = { chat: "", user: null };
  /** What the handled update sent straight to a person's chat; awaited when it is done. */
  private direct: Promise<unknown>[] = [];

  constructor(d: ChatDeps) {
    this.d = d;
    this.cards = new Cards({ config: d.config, db: d.db, clock: d.clock, log: d.log, telegram: d.telegram });
    this.people = new PersonCards({ config: d.config, db: d.db, log: d.log, telegram: d.telegram });
    this.who = { chat: this.chatId, user: null };
  }

  /** USR-11: with `[auth]`, linked people's chats are heard too. */
  private get teams(): boolean {
    return !!this.d.config.auth;
  }

  /** The update comes from a chat that is not the owner's. */
  private get theirs(): boolean {
    return this.who.chat !== this.chatId;
  }

  /** The name the messages and cards give the person who acts: "you" in the owner's chat. */
  private get by(): string {
    return this.who.user ? this.who.user.name || this.who.user.login : "you";
  }

  /** The name other chats are told: the owner's name, or the person's. */
  private get byName(): string {
    if (this.who.user) return this.by;
    const me = this.d.config.github?.me;
    return (me && getUser(this.d.db, me)?.name) || me || "the owner";
  }

  private actorOf(): Actor {
    const u = this.who.user;
    if (!u) return ownerActor(this.d.config.github?.me ?? "owner", "telegram");
    return { login: u.login, name: u.name || u.login, role: u.role, via: "telegram" };
  }

  /** USR-11: may this chat's person do `action` on `repo`? The owner's chat always may. */
  private allowed(action: UserAction, repo: string): string | null {
    const u = this.who.user;
    if (!u && this.theirs) return "that chat is not linked to a person";
    return !u || can(u, action, repo) ? null : refusal(u, action, repo);
  }

  private defer(p: Promise<unknown>): void {
    this.direct.push(p.catch((e) => this.d.log(`telegram: ${(e as Error).message}`)));
  }

  private get chatId(): string {
    return this.d.config.telegram?.chatId ?? "";
  }

  /** The outbox's sender: the Bot API, with the text and buttons of a wait made when it goes out. */
  sender(): Sender {
    const t = this.d.telegram;
    return {
      send: (text, buttons) => t.send(text, buttons),
      // A card's text is HTML (TG-17); the confirm lines of TG-4 are plain.
      edit: (m, text, buttons) => t.edit(m, text, buttons, { html: text.startsWith("<pre>") }),
      answer: (c, text) => t.answer(c, text),
      prepare: (row) => this.prepare(row),
    };
  }

  /** The shadow's view of Telegram (LOOP-129): the owner's messages the chat did not take for itself. */
  shadowSource(): { updates(offset: number): Promise<TelegramUpdate[]> } {
    return {
      updates: async () =>
        this.d.db
          .all<{ data: string }>(
            `SELECT data FROM telegram_updates WHERE state = 'shadow'
             AND update_id NOT IN (SELECT update_id FROM shadow_turns WHERE update_id IS NOT NULL)
             ORDER BY update_id`,
          )
          .map((r) => JSON.parse(r.data) as TelegramUpdate),
    };
  }

  /** LOOP-127: long-poll beside the loop; the pass only handles what is already stored. */
  start(): void {
    if (this.poller) return;
    this.stopped = false;
    this.poller = this.poll();
  }

  stop(): void {
    this.stopped = true;
    this.poller = null;
  }

  private async poll(): Promise<void> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
    let fails = 0;
    while (!this.stopped) {
      try {
        const ups = await this.d.telegram.updates(offset(this.d.db), POLL_SECONDS);
        if (this.stopped) return;
        fails = 0;
        this.store(ups);
      } catch {
        // Telegram logged it once per outage; retry with LOOP-10's backoff.
        if (this.stopped) return;
        await sleep(envBackoff(fails++) * 1000);
      }
    }
  }

  /** LOOP-126: store the owner's updates, then move the offset, in one transaction. TG-1: others are logged and dropped. */
  store(ups: TelegramUpdate[]): void {
    if (!ups.length) return;
    const { db, clock, log } = this.d;
    db.tx(() => {
      let top = offset(db);
      for (const u of ups) {
        top = Math.max(top, u.id + 1);
        const known =
          u.chat === this.chatId || (this.teams && (!!linkedUser(db, u.chat) || LINK.test(u.text ?? "")));
        if (!known) {
          log(
            `telegram: ignored update ${u.id} from chat ${u.chat || "unknown"} (${u.callback ? "button" : u.text === null ? "other" : "message"})`,
          );
          continue;
        }
        db.run(
          "INSERT OR IGNORE INTO telegram_updates (update_id, at, data) VALUES (?, ?, ?)",
          u.id,
          clock.now(),
          JSON.stringify(u),
        );
      }
      db.setMeta(OFFSET, String(top));
    });
  }

  /** One loop pass: read (unless the long poll does), handle what is stored, look at the sent messages. */
  async pass(): Promise<void> {
    if (!this.d.config.telegram) return;
    try {
      if (!this.poller) {
        try {
          this.store(await this.d.telegram.updates(offset(this.d.db), 0));
        } catch {
          // Telegram logged it once per outage; the next pass tries again.
        }
      }
      await this.handleStored();
      // FAST-8: a fast-lane mission started to wait for the owner: its card goes out now.
      const urgent = this.d.db.meta("tg:urgent") !== null;
      if (urgent) this.d.db.delMeta("tg:urgent");
      await this.syncCards(urgent);
      await this.sweep(false);
    } catch (e) {
      this.d.log(`telegram: ${(e as Error).message}`);
    }
  }

  /** TG-16: bring every intent's card up to date (at most once per sweep interval; a press forces it). */
  private async syncCards(force = false): Promise<void> {
    const now = this.d.clock.now();
    if (!force && now - this.lastCards < (this.d.sweepEvery ?? 10)) return;
    this.lastCards = now;
    let items: CardItem[];
    try {
      items = await this.d.data.cards();
    } catch {
      return;
    }
    await this.cards.sync(items);
    if (this.teams) await this.people.sync(items);
  }

  // ---- storing and handling -------------------------------------------------------------------------

  private async handleStored(): Promise<void> {
    const { db } = this.d;
    for (const r of db.all<{ update_id: number; data: string; state: string }>(
      "SELECT update_id, data, state FROM telegram_updates WHERE state IN ('new', 'handling') ORDER BY update_id",
    )) {
      const u = JSON.parse(r.data) as TelegramUpdate;
      const mark = (state: string) =>
        db.run("UPDATE telegram_updates SET state = ? WHERE update_id = ?", state, r.update_id);
      // A crash between starting and finishing: the action may or may not have happened, so it is not run again.
      if (r.state === "handling") {
        if (u.callback)
          this.put(`tg:answer:${u.id}`, "answer", "I can't tell if that went through: check the page.", {
            target: u.callback.id,
          });
        mark("done");
        continue;
      }
      mark("handling");
      try {
        this.who = { chat: u.chat, user: u.chat === this.chatId ? null : linkedUser(db, u.chat) };
        this.direct = [];
        mark(await runAs(this.actorOf(), () => this.handle(u)));
      } catch (e) {
        this.d.log(`telegram: update ${u.id}: ${(e as Error).message}`);
        mark("done");
      }
      await Promise.all(this.direct);
    }
  }

  private async handle(u: TelegramUpdate): Promise<"done" | "shadow"> {
    if (u.callback) {
      // USR-11: a press stored while the chat was linked, handled after the person was removed, does nothing.
      if (this.theirs && !this.who.user) return "done";
      await this.press(u, u.callback);
      return "done";
    }
    const text = u.text?.trim();
    if (!text) return "done";
    if (this.teams && this.theirs && LINK.test(text)) return this.linking(u, text);
    // USR-11: a chat nobody linked (or whose person was disabled since) gets nothing.
    if (this.theirs && !this.who.user) return "done";
    if (u.replyTo && !text.startsWith("/") && (await this.reply(u, text, u.replyTo))) return "done";
    const cmd = /^\/(\w+)(?:@\w+)?(?:\s|$)/.exec(text)?.[1]?.toLowerCase();
    switch (cmd) {
      case "status":
        this.say(u, await this.status());
        return "done";
      case "focus":
        await this.focus(u);
        return "done";
      case "queue":
        this.say(u, await this.queue());
        return "done";
      case "pause":
      case "resume": {
        const no = this.allowed(cmd, "");
        this.say(u, no ? `That needs more than your role: ${no}.` : await this.pause(cmd === "pause"));
        return "done";
      }
      case "fast": {
        const no = this.allowed("edit", "");
        this.say(u, no ? `That needs more than your role: ${no}.` : await this.fast(text));
        return "done";
      }
      case "confirm":
        this.say(u, await this.confirm(text));
        return "done";
      default:
        if (this.d.config.shadow.enabled && !this.theirs) return "shadow";
        this.say(u, PUBLIC_HELP);
        return "done";
    }
  }

  /** USR-11: a code from the account menu ties this chat to its person. */
  private async linking(u: TelegramUpdate, text: string): Promise<"done"> {
    const code = text.split(/\s+/)[1] ?? "";
    const user = redeemLinkCode(this.d.db, code, u.chat, this.d.clock.now());
    this.defer(
      this.d.telegram.send(
        user
          ? `Linked: this chat is now ${user.name || user.login}'s. You get what waits on you.`
          : "That code did not work: it is wrong, used or older than 10 minutes. Make a new one on your account menu.",
        undefined,
        { chat: u.chat },
      ),
    );
    return "done";
  }

  /** AUT-23: `/confirm <intent>` lets an intent a viewer wrote, or nobody, run. */
  private async confirm(text: string): Promise<string> {
    const intent = text.split(/\s+/)[1] ?? "";
    if (!intent) return "Say which one: /confirm <intent id>.";
    const repo = (await this.d.data.repoOf?.(intent).catch(() => null)) ?? "";
    const no = this.allowed("confirm", repo);
    if (no) return `That needs more than your role: ${no}.`;
    try {
      return (await this.d.actions.confirm?.(intent)) ?? "Confirming is not available here.";
    } catch (e) {
      return (e as Error).message;
    }
  }

  // ---- the outbox ------------------------------------------------------------------------------------

  private seq(): number {
    const n = Number(this.d.db.meta("telegram.seq") ?? 0) + 1;
    this.d.db.setMeta("telegram.seq", String(n));
    return n;
  }

  private put(
    key: string,
    kind: "info" | "focus" | "edit" | "answer",
    text: string,
    x: { target?: string; buttons?: Button[][]; intent?: string; wait?: string } = {},
  ): void {
    this.d.db.run(
      "INSERT OR IGNORE INTO outbox (key, mission, text, created, kind, target, buttons, intent, wait) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)",
      key,
      text,
      this.d.clock.now(),
      kind,
      x.target ?? null,
      x.buttons?.length ? JSON.stringify(x.buttons) : null,
      x.intent ?? null,
      x.wait ?? null,
    );
  }

  private say(u: TelegramUpdate, text: string): void {
    if (this.theirs) {
      this.defer(this.d.telegram.send(text, undefined, { chat: this.who.chat }));
      return;
    }
    this.put(`tg:say:${u.id}:${this.seq()}`, "info", text);
  }

  private answer(u: TelegramUpdate, text: string): void {
    if (this.theirs && u.callback) {
      this.defer(this.d.telegram.answer(u.callback.id, text));
      return;
    }
    this.put(`tg:answer:${u.id}`, "answer", text, { target: u.callback?.id });
  }

  private editRow(row: OutboxRow, text: string, buttons?: Button[][]): void {
    if (row.tg_message_id == null) return;
    if (this.theirs) {
      this.defer(this.d.telegram.edit(row.tg_message_id, text, buttons, { chat: this.who.chat }));
      return;
    }
    this.put(`tg:edit:${this.seq()}`, "edit", text, { target: String(row.tg_message_id), buttons });
  }

  /** TG-16: a card (or its ping) looks like a sent row, so the buttons' edits and restores treat it alike. */
  private cardRow(c: CardRow): OutboxRow {
    return {
      key: `card:${c.mission}`,
      mission: c.mission,
      text: c.text,
      created: 0,
      sent_at: 0,
      tries: 0,
      next_try: 0,
      kind: "card",
      intent: c.intent,
      wait: c.ping_wait,
      tg_message_id: c.message_id,
      buttons: c.buttons,
      ended_at: null,
    };
  }

  /** A person's copy of a card, shaped like a sent row so the buttons treat it as a card. */
  private personRow(c: PersonRow): OutboxRow {
    return {
      key: `pcard:${c.mission}:${c.login}`,
      mission: c.mission,
      text: c.text,
      created: 0,
      sent_at: 0,
      tries: 0,
      next_try: 0,
      kind: "card",
      intent: c.intent,
      wait: c.wait,
      tg_message_id: c.message_id,
      buttons: c.buttons,
      ended_at: null,
    };
  }

  private rowOf(message: number): OutboxRow | undefined {
    if (this.theirs) {
      const c = this.people.byMessage(this.who.chat, message);
      return c ? this.personRow(c) : undefined;
    }
    const card = this.cards.byMessage(message);
    if (card) return this.cardRow(card);
    return this.d.db.get<OutboxRow>(
      "SELECT * FROM outbox WHERE tg_message_id = ? AND kind IN ('wait', 'focus', 'info') ORDER BY created DESC LIMIT 1",
      message,
    );
  }

  /** TG-11: every message about this wait says how it ended, and is not edited again. */
  private end(intent: string, wait: string, outcome: string): void {
    for (const row of this.d.db.all<OutboxRow>(
      "SELECT * FROM outbox WHERE tg_message_id IS NOT NULL AND ended_at IS NULL AND intent = ? AND wait = ?",
      intent,
      wait,
    ))
      this.endRow(row, outcome);
  }

  private endRow(row: OutboxRow, outcome: string): void {
    this.editRow(row, endedText(row.text, outcome));
    this.d.db.run("UPDATE outbox SET ended_at = ? WHERE key = ?", this.d.clock.now(), row.key);
  }

  /**
   * LOOP-128: what a wait's row does when it goes out. TG-16: a wait the page knows is told by the intent's
   * card, so its own message is dropped; one it does not know goes out as it was written.
   */
  async prepare(row: OutboxRow): Promise<"drop" | null> {
    if (row.mission === null) return null;
    const m = getMission(this.d.db, row.mission);
    if (!m) return null;
    const wait = `${m.id}.${row.key.slice(row.key.lastIndexOf(":") + 1)}`;
    try {
      const v = (await this.d.data.waits()).find((x) => x.intent === m.intent && x.waitId === wait);
      return v ? "drop" : null;
    } catch {
      return null;
    }
  }

  private textOf(v: WaitView): string {
    return waitText(v, cardLink(this.d.config.telegram, v.intent, v.pr?.url ?? null));
  }

  // ---- buttons (TG-3, TG-4, TG-5) ---------------------------------------------------------------------

  private async press(u: TelegramUpdate, cb: NonNullable<TelegramUpdate["callback"]>): Promise<void> {
    const p = decode(cb.data);
    if (!p) return this.answer(u, "That button is not valid.");
    const row = this.rowOf(cb.message);
    if (p.op === "a" || p.op === "c") return this.pressProposal(u, p, row);
    const { actions, data } = this.d;
    const views = await data.waits();
    const v = views.find((x) => x.intent === p.a);
    if (!v) {
      this.answer(u, "That is already handled.");
      return void (await this.sweep(true));
    }
    if (v.waitId !== p.b) {
      this.answer(u, "That has changed.");
      return void (await this.sweep(true));
    }
    if (p.op === "x") {
      this.answer(u, "Cancelled.");
      if (row) this.editRow(row, row.text, row.buttons ? JSON.parse(row.buttons) : undefined);
      return;
    }
    const action = (
      { m: "merge", M: "merge", d: "drop", D: "drop", r: "retry" } as Record<
        string,
        "merge" | "drop" | "retry"
      >
    )[p.op];
    if (!action) return this.answer(u, "That button is not valid.");
    // AUT-32, AUT-33: an owner-only intent is decided on the page or GitHub, whatever the message once offered.
    const refuse = async (): Promise<string | null> => {
      const role = this.who.user ? roleOn(this.who.user, v.repo) : null;
      if (v.onlyYou && role !== "admin") return ownerOnlyLine(v.intent);
      const no = this.allowed(action, v.repo);
      if (no) return `That needs more than your role: ${no}.`;
      try {
        await actions.guard?.(v.intent, action, "telegram");
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
    const no = await refuse();
    if (no) return this.answer(u, no);
    if (!v.actions.includes(action) || (v.question && action !== "drop"))
      return this.answer(u, "That is not offered here.");
    if (p.op === "m" || p.op === "d") {
      this.answer(u, p.op === "m" ? "Tap Yes to merge." : "Tap Yes to drop.");
      // LOOP-76: a drop that would close an open PR with commits says so and asks "Close PR with N commits?".
      const warn = p.op === "d" ? await actions.closeWarning?.(v.intent).catch(() => null) : null;
      if (row)
        this.editRow(
          row,
          warn ? closeConfirmText(warn) : confirmText(p.op === "m" ? "M" : "D", v),
          confirmButtons(p.op === "m" ? "M" : "D", v),
        );
      return;
    }
    // TG-4: the merge acts on the head the message showed.
    if (p.op === "M" && p.c) {
      const live = await data.prHead(v.intent).catch(() => null);
      if (live && !live.startsWith(p.c)) {
        this.answer(u, "That has changed.");
        if (row) this.refresh(row, v);
        return;
      }
    }
    try {
      const said =
        action === "merge"
          ? await actions.merge(v.intent)
          : action === "drop"
            ? await actions.drop(v.intent)
            : await actions.retry(v.intent);
      this.answer(u, said);
      this.end(
        v.intent,
        v.waitId,
        {
          merge: `✅ merged by ${this.by}`,
          drop: `🗑 dropped by ${this.by}`,
          retry: `↩️ started over by ${this.by}`,
        }[action],
      );
      this.handled(v.intent, v.waitId);
      // The card showed the confirm: show where the intent stands now (TG-19).
      this.cards.invalidate(v.intent);
      await this.syncCards(true);
    } catch (e) {
      // The page's refusal, in the page's words; the message goes back to what it was.
      this.answer(u, (e as Error).message);
      if (row) this.refresh(row, v);
    }
  }

  /** USR-12: the copies in other chats say who decided. */
  private handled(intent: string, wait: string): void {
    if (this.teams) this.defer(this.people.handled(intent, wait, this.byName));
  }

  private refresh(row: OutboxRow, v: WaitView): void {
    // A card goes back to what it showed; the next sync brings it up to date (TG-16).
    if (row.kind === "card") {
      this.editRow(row, row.text, row.buttons ? JSON.parse(row.buttons) : undefined);
      return;
    }
    const text = this.textOf(v);
    const buttons = waitButtons(v);
    this.editRow(row, text, buttons);
    this.d.db.run(
      "UPDATE outbox SET text = ?, buttons = ? WHERE key = ?",
      text,
      buttons.length ? JSON.stringify(buttons) : null,
      row.key,
    );
  }

  private async pressProposal(u: TelegramUpdate, p: NonNullable<ReturnType<typeof decode>>, row?: OutboxRow) {
    const pr = Number(p.a);
    const found = (await this.d.data.proposals()).find((x) => x.pr === pr && x.head === p.b);
    if (!found) {
      this.answer(u, "That is already handled.");
      return void (await this.sweep(true));
    }
    const no = this.allowed(p.op === "a" ? "approve" : "drop", found.repo);
    if (no) return this.answer(u, `That needs more than your role: ${no}.`);
    try {
      const said = p.op === "a" ? await this.d.actions.accept(pr, p.b) : await this.d.actions.close(pr);
      this.answer(u, said);
      this.end(`proposal:${pr}`, p.b, p.op === "a" ? `✅ accepted by ${this.by}` : `🗑 closed by ${this.by}`);
      if (row && row.ended_at === null && row.intent === null)
        this.endRow(row, p.op === "a" ? `✅ accepted by ${this.by}` : `🗑 closed by ${this.by}`);
    } catch (e) {
      this.answer(u, (e as Error).message);
    }
  }

  // ---- replies (TG-6) ---------------------------------------------------------------------------------

  /** True when the text answered a question; false when it goes elsewhere. */
  private async reply(u: TelegramUpdate, text: string, to: number): Promise<boolean> {
    // TG-6, TG-20: a reply to an intent's card or its ping answers the question the card asks.
    const mine = this.theirs ? this.people.byMessage(this.who.chat, to) : undefined;
    const card = this.theirs ? undefined : this.cards.byMessage(to);
    const row = card || mine || this.theirs ? undefined : this.rowOf(to);
    const copy = card ?? mine;
    if (!copy && (!row?.intent || !row.wait || !row.text.includes(REPLY_LINE))) return false;
    const intent = card ? card.intent : mine ? mine.intent : row!.intent!;
    const shown = card ? card.ping_wait : mine ? mine.wait : row!.wait!;
    const v = (await this.d.data.waits()).find((x) => x.intent === intent);
    if (copy && v && !v.question) return false;
    if (copy && !v && !shown) return false;
    if (!v || (shown && v.waitId !== shown)) {
      this.say(u, "That is already handled.");
      await this.sweep(true);
      return true;
    }
    try {
      const role = this.who.user ? roleOn(this.who.user, v.repo) : null;
      if (v.onlyYou && (this.theirs ? role !== "admin" : true)) throw new Error(ownerOnlyLine(v.intent));
      // USR-12: a contributor may answer on an intent they wrote; everyone else needs `reply`.
      const writer = peopleOf(this.d.db, v.intent)?.writer;
      const own = !!this.who.user && writer === this.who.user.login.toLowerCase();
      const no =
        own && this.who.user && can(this.who.user, "answer", v.repo) ? null : this.allowed("reply", v.repo);
      if (no) throw new Error(`That needs more than your role: ${no}.`);
      await this.d.actions.guard?.(v.intent, "reply", "telegram");
      const said = await this.d.actions.reply(v.intent, text);
      this.end(v.intent, v.waitId, `✅ answered by ${this.by}`);
      this.handled(v.intent, v.waitId);
      this.say(u, said);
    } catch (e) {
      this.say(u, (e as Error).message);
    }
    return true;
  }

  // ---- commands (TG-7..10) ----------------------------------------------------------------------------

  private link(intent: string): string {
    const l = cardLink(this.d.config.telegram, intent, null);
    return l ? ` ${l}` : "";
  }

  private async status(): Promise<string> {
    const { data, config, db, clock } = this.d;
    const [running, waits, proposals] = await Promise.all([data.running(), data.waits(), data.proposals()]);
    const lines: string[] = [];
    const n = running.length;
    if (this.isPaused()) lines.push(n ? `Paused: ${plural(n, "step", "steps")} finishing.` : "Paused.");
    const all = [
      ...running.map((r) => `▶ ${trim(r.title, 40)}: ${trim(r.step, 20)}${this.link(r.intent)}`),
      ...waits.map((w) => `⏳ ${trim(w.title, 40)}: ${trim(w.ask, 30)}${this.link(w.intent)}`),
      ...proposals.map((p) => `💡 ${trim(p.title, 40)}: proposed${p.url ? ` ${p.url}` : ""}`),
    ];
    if (!all.length && !lines.length) lines.push("Nothing is running and nothing needs you.");
    lines.push(...all.slice(0, MAX_LINES));
    if (all.length > MAX_LINES) lines.push(`and ${all.length - MAX_LINES} more`);
    if (config.shadow.enabled)
      lines.push(`Shadow: ${statusText(db, config.shadow, clock.now()).split("\n")[0] ?? ""}`);
    return lines.join("\n");
  }

  private async focus(u: TelegramUpdate): Promise<void> {
    const f = await this.d.data.focus();
    const more = f.more > 0 ? `\n${f.more} more waiting` : "";
    if (f.wait) {
      const v = f.wait;
      const buttons = waitButtons(v);
      const body = waitText(v, null);
      this.put(
        `tg:focus:${u.id}`,
        "focus",
        withLink(`${body}${more}`, cardLink(this.d.config.telegram, v.intent, v.pr?.url ?? null)),
        {
          buttons,
          intent: v.intent,
          wait: v.waitId,
        },
      );
    } else if (f.proposal) {
      const p = f.proposal;
      this.put(`tg:focus:${u.id}`, "focus", `${proposalText(p, null)}${more}\n${p.url}`, {
        buttons: proposalButtons(p),
        intent: `proposal:${p.pr}`,
        wait: p.head,
      });
    } else this.say(u, "Nothing needs you.");
  }

  private async queue(): Promise<string> {
    const q = await this.d.data.queue();
    if (!q.length) return "The queue is empty.";
    const lines = q
      .slice(0, MAX_LINES)
      .map((x, i) => `${i + 1}. ${trim(x.title, 50)} (${x.repo}) · ${x.state}`);
    if (q.length > MAX_LINES) lines.push(`and ${q.length - MAX_LINES} more`);
    return lines.join("\n");
  }

  /** Paused as the loop will have it: a pause or resume still waiting in `commands` counts. */
  private isPaused(): boolean {
    const last = this.d.db.get<{ name: string }>(
      "SELECT name FROM commands WHERE name IN ('pause', 'resume') AND arg = '' AND applied_at IS NULL ORDER BY id DESC LIMIT 1",
    );
    return last ? last.name === "pause" : this.d.db.meta("paused") === "1";
  }

  private async pause(pause: boolean): Promise<string> {
    if (this.isPaused() === pause) return pause ? "Already paused." : "Not paused.";
    if (pause) {
      await this.d.actions.pause();
      const n = (await this.d.data.running()).length;
      return n ? `Paused. ${plural(n, "step is", "steps are")} finishing.` : "Paused.";
    }
    await this.d.actions.resume();
    return "Resumed.";
  }

  /** FAST-1, FAST-9: `/fast <id>` or `/fast <id> off`, from the owner's chat only (the update store drops the rest). */
  private async fast(text: string): Promise<string> {
    const [, id, word] = text.split(/\s+/);
    if (!id || (word !== undefined && word.toLowerCase() !== "off"))
      return "Say /fast <id> or /fast <id> off.";
    if (!this.d.actions.fast) return "The fast lane isn't available.";
    try {
      return await this.d.actions.fast(id, word === undefined, "owner", "telegram");
    } catch (e) {
      return (e as Error).message;
    }
  }

  // ---- messages that outlive their wait (TG-11, TG-12) -----------------------------------------------

  /** Edit the messages of waits that ended, and those whose text changed while the wait stands. */
  async sweep(force: boolean): Promise<void> {
    const { db, clock } = this.d;
    if (force) await this.syncCards(true);
    const now = clock.now();
    if (!force && now - this.lastSweep < (this.d.sweepEvery ?? 10)) return;
    this.lastSweep = now;
    const rows = db.all<OutboxRow>(
      "SELECT * FROM outbox WHERE tg_message_id IS NOT NULL AND ended_at IS NULL AND intent IS NOT NULL AND kind IN ('wait', 'focus')",
    );
    if (!rows.length) return;
    let proposals: ProposalView[] | null = null;
    const standing: OutboxRow[] = [];
    for (const row of rows) {
      if (row.intent!.startsWith("proposal:")) {
        proposals ??= await this.d.data.proposals().catch(() => null);
        if (proposals && !proposals.some((p) => `proposal:${p.pr}` === row.intent && p.head === row.wait))
          this.endRow(row, "✅ no longer needed");
        continue;
      }
      const m = unfinishedFor(db, row.intent!);
      const current = m?.waiting && !finished(m.stage) ? `${m.id}.${m.continued}` : null;
      if (current !== row.wait) this.endRow(row, this.outcomeOf(row));
      else if (row.kind === "wait") standing.push(row);
    }
    if (!standing.length) return;
    let views: WaitView[];
    try {
      views = await this.d.data.waits();
    } catch {
      return;
    }
    for (const row of standing) {
      const v = views.find((x) => x.intent === row.intent && x.waitId === row.wait);
      if (!v) continue;
      const text = this.textOf(v);
      const buttons = waitButtons(v);
      const shown = row.buttons ?? "";
      if (text !== row.text || (buttons.length ? JSON.stringify(buttons) : "") !== shown)
        this.refresh(row, v);
    }
  }

  /** How the wait of `row` ended, from the move that left it. */
  private outcomeOf(row: OutboxRow): string {
    const { db, config } = this.d;
    const id = Number(row.wait?.split(".")[0]);
    const t = db.get<{ event: string }>(
      "SELECT event FROM transitions WHERE mission = ? AND (from_stage LIKE 'approval:%' OR from_stage = 'blocked') ORDER BY id DESC LIMIT 1",
      id,
    );
    const m = getMission(db, id);
    switch (t?.event) {
      case "spec_merged":
      case "plan_merged":
      case "code_merged":
        return m?.merged_by && m.merged_by.toLowerCase() === config.github?.me.toLowerCase()
          ? "✅ merged by you on GitHub"
          : "✅ merged";
      case "answered":
      case "feedback":
        return "✅ answered by you";
      case "retry_fresh":
        return "↩️ started over by you";
      case "intent_removed":
      case "closed":
        return "🗑 dropped by you";
      default:
        return "✅ no longer needed";
    }
  }
}
