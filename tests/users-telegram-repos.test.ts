// USR-5, USR-9, USR-11: a Telegram decision needs the role on every repo the intent changes, and a contributor
// can't answer a question that grants the worker access.

import { expect, test } from "vitest";
import { Chat } from "../src/telegram/chat.ts";
import { newLinkCode } from "../src/telegram/people.ts";
import type { UiActions } from "../src/ui/actions.ts";
import { addUser, ensureFirstAdmin } from "../src/users/store.ts";
import type { Role, User } from "../src/users.ts";
import { ChatRig } from "./helpers/telegram.ts";

const admin: User = { login: "owner", role: "admin", repos: {} };

/** A chat with sign-in on; `calls` records who did what through the fake page actions. */
function rig() {
  const r = new ChatRig(
    {},
    { auth: { client_id: "id", client_secret_env: "S", public_url: "https://tc.example.com" } },
  );
  ensureFirstAdmin(r.db, "owner", 1);
  const calls: string[] = [];
  const act = (name: string, by: string) => async (intent?: string, text?: string) => {
    calls.push([name, intent, text, `by ${by}`].filter(Boolean).join(" "));
    return `${name} done`;
  };
  const actionsFor = (by: string) =>
    ({
      merge: act("merge", by),
      drop: act("drop", by),
      retry: act("retry", by),
      reply: act("reply", by),
      pause: async () => "paused",
      resume: async () => "resumed",
      guard: async () => {},
      as: (a: { login: string }) => actionsFor(a.login),
    }) as unknown as UiActions;
  r.chat = new Chat({
    config: r.config,
    db: r.db,
    clock: r.clock,
    log: (l) => r.logs.push(l),
    telegram: r.tg,
    actions: actionsFor("owner"),
    data: {
      waits: async () => r.views,
      proposals: async () => [],
      focus: async () => ({ wait: null, proposal: null, more: 0 }),
      queue: async () => [],
      running: async () => [],
      prHead: async () => null,
      cards: async () => [...r.cardState.values()],
    },
    addIntent: async () => ({ id: "261109-1000" }),
    sweepEvery: 0,
    sleep: async () => {},
  });
  /** Add a person and link their chat with a one-time code, the way the page does. */
  const person = async (login: string, role: Role, chat: string, repos: Record<string, Role> = {}) => {
    addUser(r.db, admin, login, { role, repos }, 1);
    r.say(`/link ${newLinkCode(r.db, login, r.clock.now())}`, { chat });
    await r.run();
  };
  /** The chats that got a `sendMessage` since `from`. */
  const chats = (from = 0) =>
    r
      .calls("sendMessage")
      .slice(from)
      .map((b) => String(b.chat_id));
  return { r, calls, person, chats };
}

const sentTo = (r: ChatRig, chat: string) => r.calls("sendMessage").filter((b) => String(b.chat_id) === chat);

test("users: telegram needs the role on every repo of the intent", async () => {
  const { r, calls, person } = rig();
  // A maintainer of web only (api falls to viewer), and one of both.
  await person("one", "viewer", "100", { web: "maintainer" });
  await person("both", "viewer", "101", { web: "maintainer", api: "maintainer" });
  r.wait("i-1", { repos: ["web", "api"] });
  await r.run();
  expect(sentTo(r, "100")).toHaveLength(1); // only the link reply: no card
  expect(sentTo(r, "101")).toHaveLength(2);
  expect(JSON.stringify(sentTo(r, "101").at(-1)!.reply_markup)).toContain("Merge");
  // The first person forges the second one's button: refused, nothing merged.
  const card = sentTo(r, "101").at(-1)!;
  const merge = (
    card.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
  ).inline_keyboard
    .flat()
    .find((b) => b.text === "Merge")!;
  const messageId = 100 + r.calls("sendMessage").lastIndexOf(card);
  r.db.run(
    "INSERT OR IGNORE INTO tg_card_chats (mission, chat, message_id, text, wait) SELECT mission, '100', ?, text, wait FROM tg_card_chats WHERE chat = '101'",
    messageId,
  );
  r.press(merge.callback_data, messageId, "100");
  await r.run();
  expect(calls).toEqual([]);
  expect(r.calls("answerCallbackQuery").at(-1)!.text).toBe("your role (viewer) can't merge on api");
});

test("users: a contributor gets no telegram question that grants access", async () => {
  const { r, person } = rig();
  await person("cy", "contributor", "102");
  r.wait("i-1", { question: true, actions: ["drop"], ask: "Which currency?" });
  r.wait("i-2", { question: true, actions: ["drop"], ask: "Allow network example.com?", grant: true });
  r.db.setMeta("writer:i-1", JSON.stringify({ login: "cy", via: "github" }));
  r.db.setMeta("writer:i-2", JSON.stringify({ login: "cy", via: "github" }));
  await r.run();
  const texts = sentTo(r, "102").map((b) => String(b.text));
  expect(texts.some((t) => t.includes("Which currency?"))).toBe(true);
  expect(texts.some((t) => t.includes("Allow network"))).toBe(false);
});
