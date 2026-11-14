// USR-11, USR-12 (and AUT-23's Telegram writer): each person links their own chat, gets only what waits on
// them, and acts as their role allows.

import { expect, test } from "vitest";
import { Chat } from "../src/telegram/chat.ts";
import { newLinkCode } from "../src/telegram/people.ts";
import type { UiActions } from "../src/ui/actions.ts";
import { addUser, ensureFirstAdmin } from "../src/users/store.ts";
import { writerOf } from "../src/users/writer.ts";
import type { Role, User } from "../src/users.ts";
import { CHAT, ChatRig } from "./helpers/telegram.ts";

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

const linked = (r: ChatRig, login: string) =>
  r.db.get<{ telegram_chat: string | null }>("SELECT telegram_chat FROM users WHERE login = ?", login)
    ?.telegram_chat;
const sentTo = (r: ChatRig, chat: string) => r.calls("sendMessage").filter((b) => String(b.chat_id) === chat);

test("users: a code links a chat to its person", async () => {
  const { r, person } = rig();
  await person("max", "maintainer", "100");
  expect(linked(r, "max")).toBe("100");
  expect(String(sentTo(r, "100")[0]!.text)).toContain("Linked: this chat is now max's");
  // One chat per person: linking again replaces; one chat belongs to one person.
  addUser(r.db, admin, "mia", { role: "maintainer" }, 1);
  r.say(`/link ${newLinkCode(r.db, "max", r.clock.now())}`, { chat: "105" });
  r.say(`/link ${newLinkCode(r.db, "mia", r.clock.now())}`, { chat: "105" });
  await r.run();
  expect(linked(r, "max")).toBeNull();
  expect(linked(r, "mia")).toBe("105");
});

test("users: a code works once and expires", async () => {
  const { r, person } = rig();
  await person("max", "maintainer", "100");
  const code = newLinkCode(r.db, "max", r.clock.now());
  r.say(`/link ${code}`, { chat: "106" });
  r.say(`/link ${code}`, { chat: "107" });
  await r.run();
  expect(linked(r, "max")).toBe("106");
  expect(String(sentTo(r, "107")[0]!.text)).toContain("That code doesn't work");
  // A code is good for 10 minutes only.
  const late = newLinkCode(r.db, "max", r.clock.now());
  r.clock.advance(601);
  r.say(`/link ${late}`, { chat: "108" });
  await r.run();
  expect(linked(r, "max")).toBe("106");
  expect(String(sentTo(r, "108")[0]!.text)).toContain("That code doesn't work");
});

test("users: an unlinked chat is ignored", async () => {
  const { r } = rig();
  r.wait("i-1");
  r.say("/status", { chat: "999" });
  r.say("/pause", { chat: "999" });
  r.say("merge it", { chat: "999" });
  await r.run();
  expect(sentTo(r, "999")).toEqual([]);
  expect(r.logs.filter((l) => l.includes("ignored update"))).toHaveLength(3);
  // The owner's own chat is unchanged.
  expect(sentTo(r, CHAT).length).toBeGreaterThan(0);
});

test("users: a decision card goes to maintainers of that repo", async () => {
  const { r, person } = rig();
  await person("max", "maintainer", "100");
  await person("mia", "viewer", "103", { web: "maintainer" });
  await person("ann", "viewer", "104", { api: "maintainer" });
  await person("vi", "viewer", "101");
  r.wait("i-1");
  await r.run();
  expect(sentTo(r, "100")).toHaveLength(2); // the link reply and the card
  expect(sentTo(r, "103")).toHaveLength(2);
  expect(sentTo(r, "104")).toHaveLength(1); // only the link reply: a maintainer of api, not of web
  expect(sentTo(r, "101")).toHaveLength(1);
  const card = sentTo(r, "100").at(-1)!;
  expect(String(card.text)).toContain("Add export");
  expect(JSON.stringify(card.reply_markup)).toContain("Merge");
  // The owner's chat still gets its card.
  expect(sentTo(r, CHAT).length).toBeGreaterThan(0);
});

test("users: a viewer gets no telegram message", async () => {
  const { r, person } = rig();
  await person("vi", "viewer", "101");
  await person("cy", "contributor", "102");
  r.wait("i-1");
  r.wait("i-2", { question: true, actions: ["drop"], ask: "Which currency?" });
  r.db.setMeta("writer:i-2", JSON.stringify({ login: "cy", via: "github" }));
  await r.run();
  // The viewer got only the link reply. The contributor got the question on their own intent, not the merge.
  expect(sentTo(r, "101")).toHaveLength(1);
  const mine = sentTo(r, "102").map((b) => String(b.text));
  expect(mine).toHaveLength(2);
  expect(mine[1]).toContain("Which currency?");
  expect(mine.some((t) => t.includes("Review and merge"))).toBe(false);
  expect(writerOf(r.db, "i-2")?.login).toBe("cy");
});

test("users: a telegram action follows the role", async () => {
  const { r, calls, person } = rig();
  await person("max", "maintainer", "100");
  await person("vi", "viewer", "101");
  r.wait("i-1");
  await r.run();
  const card = sentTo(r, "100").at(-1)!;
  const messageId = 100 + r.calls("sendMessage").lastIndexOf(card);
  const merge = (
    card.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
  ).inline_keyboard
    .flat()
    .find((b) => b.text === "Merge")!;
  // A viewer who forges the maintainer's button gets nothing done.
  r.press(merge.callback_data, messageId, "101");
  await r.run();
  expect(calls).toEqual([]);
  // The maintainer taps Merge, then Yes.
  r.press(merge.callback_data, messageId, "100");
  await r.run();
  const yes = r
    .edits()
    .flatMap((e) => e.keyboard as { text: string; callback_data: string }[][])
    .flat()
    .find((b) => b.text === "Yes, merge");
  expect(yes).toBeTruthy();
  r.press(yes!.callback_data, messageId, "100");
  await r.run();
  expect(calls).toEqual(["merge i-1 by max"]);
  // The same person demoted to viewer between the two taps is refused.
  const w2 = rig();
  await w2.person("max", "maintainer", "100");
  w2.r.wait("i-1");
  await w2.r.run();
  const c2 = sentTo(w2.r, "100").at(-1)!;
  const id2 = 100 + w2.r.calls("sendMessage").lastIndexOf(c2);
  const m2 = (
    c2.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
  ).inline_keyboard
    .flat()
    .find((b) => b.text === "Merge")!;
  w2.r.db.run("UPDATE users SET role = 'viewer' WHERE login = 'max'");
  w2.r.press(m2.callback_data, id2, "100");
  await w2.r.run();
  expect(w2.calls).toEqual([]);
  expect(w2.r.calls("answerCallbackQuery").at(-1)!.text).toBe("your role (viewer) can't merge on web");
});

test("users: other copies are edited when one person decides", async () => {
  const { r, calls, person } = rig();
  await person("max", "maintainer", "100");
  await person("mia", "maintainer", "103");
  r.wait("i-1");
  await r.run();
  const sends = r.calls("sendMessage");
  const idOf = (chat: string) => 100 + sends.findLastIndex((b) => String(b.chat_id) === chat);
  const card = sentTo(r, "100").at(-1)!;
  const merge = (
    card.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
  ).inline_keyboard
    .flat()
    .find((b) => b.text === "Merge")!;
  r.press(merge.callback_data, idOf("100"), "100");
  await r.run();
  const yes = r
    .edits()
    .flatMap((e) => e.keyboard as { text: string; callback_data: string }[][])
    .flat()
    .find((b) => b.text === "Yes, merge")!;
  r.press(yes.callback_data, idOf("100"), "100");
  await r.run();
  expect(calls).toEqual(["merge i-1 by max"]);
  // Mia's copy now says who handled it, and carries no buttons.
  r.leave(1, "code_merged", "max");
  await r.run();
  const mia = r
    .calls("editMessageText")
    .filter((b) => String(b.chat_id) === "103" && b.message_id === idOf("103"));
  expect(String(mia.at(-1)!.text)).toContain("✅ handled by max");
  expect(JSON.stringify(mia.at(-1)!.reply_markup)).toBe('{"inline_keyboard":[]}');
});

test("autonomy: a telegram intent has the linked person as writer", async () => {
  const { r, person } = rig();
  await person("cy", "contributor", "102");
  await person("vi", "viewer", "101");
  r.say("/add web: Make the button blue", { chat: "102" });
  r.say("/add web: Make it red", { chat: "101" });
  await r.run();
  expect(writerOf(r.db, "261109-1000")).toEqual({ login: "cy", via: "telegram" });
  expect(sentTo(r, "102").some((b) => String(b.text).includes("Added 261109-1000 in web"))).toBe(true);
  expect(
    sentTo(r, "101").some((b) => String(b.text).includes("your role (viewer) can't create on web")),
  ).toBe(true);
});
