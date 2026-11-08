// A chat over fakes: a fake Bot API behind the real `Telegram` class, fake page actions, fake page data, an
// in-memory database and a clock the test moves. Hermetic: nothing here touches the network.

import type { HttpRequest, HttpResponse } from "../../src/github/app.ts";
import { sendDue } from "../../src/outbox.ts";
import { buildTrack, type CardView } from "../../src/telegram/card.ts";
import type { CardItem } from "../../src/telegram/cards.ts";
import { Chat, type ChatData } from "../../src/telegram/chat.ts";
import type { ProposalView, WaitView } from "../../src/telegram/render.ts";
import { Telegram } from "../../src/telegram.ts";
import type { UiActions } from "../../src/ui/actions.ts";
import { TestClock, testConfig, testDb } from "./world.ts";

export const CHAT = "42";
export const TOKEN = "123:tok";

export interface Sent {
  id: number;
  text: string;
  keyboard: { text: string; callback_data: string }[][] | undefined;
}

/** The labels of a message's buttons, in order. */
export const labels = (s: Sent | undefined): string[] => (s?.keyboard ?? []).flat().map((b) => b.text);

export class ChatRig {
  config;
  db = testDb();
  clock = new TestClock();
  requests: { method: string; url: string; body: Record<string, unknown> }[] = [];
  /** Raw Bot API updates the fake `getUpdates` offers. */
  incoming: Record<string, unknown>[] = [];
  nextUpdate = 1;
  nextMessage = 100;
  refuseEdits = false;
  failApi = false;
  /** With `gated`, each long `getUpdates` waits here until the test calls the function. */
  gated = false;
  pending: (() => void)[] = [];
  logs: string[] = [];
  actionCalls: string[] = [];
  actionFails: Record<string, string> = {};
  paused = false;
  views: WaitView[] = [];
  proposals: ProposalView[] = [];
  queueRows: { title: string; repo: string; state: string }[] = [];
  runningRows: { intent: string; title: string; step: string }[] = [];
  heads: Record<string, string> = {};
  focusPick: { wait: WaitView | null; proposal: ProposalView | null; more: number } = {
    wait: null,
    proposal: null,
    more: 0,
  };
  /** TG-16: the cards the fake page knows, by mission; `wait`, `leave` and `finish` keep them. */
  cardState = new Map<number, CardItem>();
  /** The last wait each mission asked, for `rewait`. */
  private lastWait = new Map<number, WaitView>();
  /** TG-22 and TG-20: refuse `deleteMessage` (the ping is gone or too old). */
  refuseDeletes = false;
  chat: Chat;
  tg: Telegram;
  private n = 0;

  constructor(
    telegram: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
    ops: { noTelegram?: boolean } = {},
  ) {
    this.config = testConfig({
      ...(ops.noTelegram ? {} : { telegram: { bot_token: TOKEN, chat_id: CHAT, ...telegram } }),
      ...extra,
    });
    this.tg = new Telegram(
      this.config.telegram ?? { botToken: TOKEN, chatId: CHAT, apiBase: "https://tg.test" },
      (r) => this.http(r),
      (l) => this.logs.push(l),
    );
    const data: ChatData = {
      waits: async () => this.views,
      proposals: async () => this.proposals,
      focus: async () => this.focusPick,
      queue: async () => this.queueRows,
      running: async () => this.runningRows,
      prHead: async (i) => this.heads[i] ?? null,
      cards: async () => [...this.cardState.values()],
    };
    this.chat = new Chat({
      config: this.config,
      db: this.db,
      clock: this.clock,
      log: (l) => this.logs.push(l),
      telegram: this.tg,
      actions: this.actions(),
      data,
      sweepEvery: 0,
      sleep: async () => {},
    });
  }

  private async http(req: HttpRequest): Promise<HttpResponse> {
    const method = /\/bot[^/]+\/(\w+)/.exec(req.url)?.[1] ?? "";
    const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
    this.requests.push({ method, url: req.url, body });
    if (this.failApi) throw new Error("ETIMEDOUT");
    const ok = (result: unknown): HttpResponse => ({
      status: 200,
      text: JSON.stringify({ ok: true, result }),
    });
    if (method === "getUpdates") {
      if (this.gated && /timeout=2\d/.test(req.url)) await new Promise<void>((r) => this.pending.push(r));
      const from = Number(/offset=(\d+)/.exec(req.url)?.[1] ?? 0);
      return ok(this.incoming.filter((u) => (u.update_id as number) >= from));
    }
    if (method === "sendMessage") return ok({ message_id: this.nextMessage++ });
    if ((method === "editMessageText" || method === "answerCallbackQuery") && this.refuseEdits)
      return { status: 400, text: '{"ok":false,"description":"Bad Request: message to edit not found"}' };
    if (method === "deleteMessage" && this.refuseDeletes)
      return { status: 400, text: '{"ok":false,"description":"Bad Request: message to delete not found"}' };
    return ok(true);
  }

  private actions(): UiActions {
    const act = (name: string) => async (intent?: string, text?: string) => {
      this.actionCalls.push([name, intent, text].filter((x) => x !== undefined && x !== "").join(" "));
      const fail = this.actionFails[name];
      if (fail) throw new Error(fail);
      return `${name} done`;
    };
    const commands = (name: "pause" | "resume") => async () => {
      this.actionCalls.push(name);
      this.db.run(
        "INSERT INTO commands (name, arg, text, source, created) VALUES (?, '', '', 'ui', ?)",
        name,
        this.clock.now(),
      );
      return `${name} done`;
    };
    return {
      merge: act("merge"),
      drop: act("drop"),
      retry: act("retry"),
      reply: act("reply"),
      start: act("start"),
      pause: commands("pause"),
      resume: commands("resume"),
      accept: async (pr: number, head: string) => {
        this.actionCalls.push(`accept ${pr} ${head}`);
        return "accept done";
      },
      close: async (pr: number) => {
        this.actionCalls.push(`close ${pr}`);
        return "close done";
      },
      guard: async (intent: string, action: string, actor: string) => {
        this.actionCalls.push(`guard ${intent} ${action} ${actor}`);
        if (this.a0.has(intent) && action !== "pause")
          throw new Error(`${intent} is only yours: use GitHub or the page`);
      },
    } as unknown as UiActions;
  }

  /** Intents that are owner-only (a0) for the fake `guard`. */
  a0 = new Set<string>();

  // ---- the owner writes and taps -----------------------------------------------------------------------

  say(text: string, over: { chat?: string; replyTo?: number } = {}): number {
    const id = this.nextUpdate++;
    this.incoming.push({
      update_id: id,
      message: {
        message_id: 900 + id,
        chat: { id: Number(over.chat ?? CHAT) },
        text,
        ...(over.replyTo ? { reply_to_message: { message_id: over.replyTo } } : {}),
      },
    });
    return id;
  }

  press(data: string, message: number, chat = CHAT): number {
    const id = this.nextUpdate++;
    this.incoming.push({
      update_id: id,
      callback_query: { id: `cb${id}`, data, message: { message_id: message, chat: { id: Number(chat) } } },
    });
    return id;
  }

  // ---- missions, waits, passes ---------------------------------------------------------------------------

  /** A mission waiting on the owner, its outbox row (as `machine.apply` writes it) and its view. */
  wait(
    intent = "i-1",
    over: Partial<WaitView> = {},
    waiting = "review and merge PR",
  ): { id: number; key: string; view: WaitView } {
    const stage = over.question ? "blocked" : "approval:merge";
    const id = this.db.run(
      `INSERT INTO missions (intent, repo, attempt, stage, waiting, model, session, checkout, branch, pr, head, created, updated)
       VALUES (?, 'web', 1, ?, ?, 'opus', 's', 'w', 'b', 7, 'abcdef0123', 0, 0)`,
      intent,
      stage,
      waiting,
    ).lastId;
    const key = `${id}:${waiting}:0`;
    this.db.run(
      "INSERT INTO outbox (key, mission, text, created) VALUES (?, ?, 'raw text', ?)",
      key,
      id,
      this.clock.now() + ++this.n,
    );
    const view: WaitView = {
      intent,
      title: "Add export",
      repo: "web",
      ask: "Review and merge the code",
      why: "The checks are green.",
      question: false,
      actions: ["merge", "retry", "drop"],
      onlyYou: false,
      waitId: `${id}.0`,
      head: "abcdef0123",
      pr: { number: 7, url: "https://github.com/owner/web/pull/7", label: "code PR" },
      base: "main",
      ...over,
    };
    this.views = [...this.views.filter((v) => v.intent !== intent), view];
    this.lastWait.set(id, view);
    this.cardState.set(id, this.card(id, view, { track: buildTrack(over.question ? 2 : 3, 0, false) }));
    return { id, key, view };
  }

  /** A card as the fake page shows it; with a wait it asks, without one it works. */
  card(id: number, wait: WaitView | null, over: Partial<CardView> = {}): CardItem {
    const m = this.db.get<{ intent: string; repo: string; continued: number }>(
      "SELECT intent, repo, continued FROM missions WHERE id = ?",
      id,
    );
    return {
      wait,
      view: {
        intent: m?.intent ?? "i-1",
        mission: id,
        title: "Add export",
        repo: m?.repo ?? "web",
        track: buildTrack(2, 0, false),
        status: "Building",
        ask: wait?.ask ?? null,
        question: wait?.question ?? false,
        onlyYou: wait?.onlyYou ?? false,
        waitId: wait?.waitId ?? null,
        final: null,
        link: wait ? (wait.pr?.url ?? null) : "https://github.com/owner/web/pull/7",
        ...over,
      },
    };
  }

  /** The mission goes on working: its card shows `status` at track position `at`, and nothing is asked. */
  work(id: number, status = "Building", at = 2): void {
    this.views = this.views.filter((v) => Number(v.waitId.split(".")[0]) !== id);
    this.cardState.set(id, this.card(id, null, { status, track: buildTrack(at, 0, false) }));
  }

  /** A new wait on the same mission (the wait counter moves on, as `machine.apply` does). */
  rewait(id: number, over: Partial<WaitView> = {}): WaitView {
    const cur = this.db.get<{ continued: number; intent: string }>(
      "SELECT continued, intent FROM missions WHERE id = ?",
      id,
    )!;
    this.db.run("UPDATE missions SET continued = ? WHERE id = ?", cur.continued + 1, id);
    const view: WaitView = { ...this.lastWait.get(id)!, waitId: `${id}.${cur.continued + 1}`, ...over };
    this.lastWait.set(id, view);
    this.views = [...this.views.filter((v) => v.intent !== cur.intent), view];
    this.cardState.set(id, this.card(id, view, { track: buildTrack(view.question ? 2 : 3, 0, false) }));
    return view;
  }

  /** The mission ended: `final` is the card's last line (TG-21). */
  finish(id: number, final: string): void {
    this.views = this.views.filter((v) => Number(v.waitId.split(".")[0]) !== id);
    this.cardState.set(id, this.card(id, null, { final, track: buildTrack(3, 0, final.startsWith("✅")) }));
  }

  /** The mission ended its wait: it moves to `build` through `event`. */
  leave(id: number, event: string, mergedBy: string | null = null): void {
    this.db.run(
      "UPDATE missions SET stage = 'build', waiting = NULL, merged_by = ? WHERE id = ?",
      mergedBy,
      id,
    );
    this.db.run(
      "INSERT INTO transitions (mission, at, from_stage, event, to_stage) VALUES (?, 0, 'approval:merge', ?, 'build')",
      id,
      event,
    );
    this.views = [];
    this.work(id);
  }

  /** Send what is due through the chat's sender. */
  async deliver(): Promise<void> {
    await sendDue(this.db, this.chat.sender(), this.clock.now());
  }

  /** One loop pass: the chat, then the outbox. */
  async run(): Promise<void> {
    await this.chat.pass();
    await this.deliver();
  }

  /** Every request to one Bot API method. */
  calls(method: string) {
    return this.requests.filter((r) => r.method === method).map((r) => r.body);
  }

  /** The messages sent so far. */
  sent(): Sent[] {
    return this.calls("sendMessage").map((b, i) => ({
      id: 100 + i,
      text: String(b.text),
      keyboard: (b.reply_markup as { inline_keyboard: Sent["keyboard"] } | undefined)?.inline_keyboard,
    }));
  }

  edits(): { message: number; text: string; keyboard: unknown }[] {
    return this.calls("editMessageText").map((b) => ({
      message: b.message_id as number,
      text: String(b.text),
      keyboard: (b.reply_markup as { inline_keyboard: unknown }).inline_keyboard,
    }));
  }

  answers(): string[] {
    return this.calls("answerCallbackQuery").map((b) => String(b.text));
  }

  /** The callback data of a button on a sent message. */
  data(message: Sent | undefined, label: string): string {
    const b = (message?.keyboard ?? []).flat().find((x) => x.text === label);
    if (!b) throw new Error(`no button ${label}`);
    return b.callback_data;
  }

  /** A pending shadow-bound update count. */
  shadowQueue(): number {
    return this.db.all("SELECT 1 FROM telegram_updates WHERE state = 'shadow'").length;
  }
}
