import { describe, expect, test } from "vitest";
import { currentActor } from "../src/actor.ts";
import { recordWriter } from "../src/intent-people.ts";
import { createLinkCode, redeemLinkCode } from "../src/telegram/people.ts";
import { addUser } from "../src/users-store.ts";
import { ChatRig } from "./helpers/telegram.ts";

const AUTH = { client_id: "id", client_secret_env: "X", public_url: "https://tc.example" };

/** A rig with `[auth]` and these people added: login -> role (and optional repo roles). */
function team(people: Record<string, { role: string; repoRoles?: object; name?: string }>) {
  const rig = new ChatRig({}, { auth: AUTH });
  for (const [login, p] of Object.entries(people))
    addUser(
      rig.db,
      { login, name: p.name ?? login, role: p.role as "viewer", repoRoles: p.repoRoles, by: "root" },
      0,
    );
  return rig;
}

/** Links `login`'s chat through the real code and message path. */
async function link(rig: ChatRig, login: string, chat: string) {
  rig.say(`/link ${createLinkCode(rig.db, login, rig.clock.now())}`, { chat });
  await rig.run();
}

/** The messages sent to one chat. */
const to = (rig: ChatRig, chat: string) => rig.calls("sendMessage").filter((b) => String(b.chat_id) === chat);

/** The message id of a person's copy of a card. */
const copyOf = (rig: ChatRig, login: string): number =>
  rig.db.get<{ message_id: number }>("SELECT message_id FROM tg_person_cards WHERE login = ?", login)!
    .message_id;

describe("users: linking a telegram chat", () => {
  test("users: a code links a chat to its person", async () => {
    const rig = team({ ana: { role: "maintainer", name: "Ana Diaz" } });
    await link(rig, "ana", "77");
    expect(rig.db.all("SELECT login, chat FROM tg_links")).toEqual([{ login: "ana", chat: "77" }]);
    expect(String(to(rig, "77")[0]!.text)).toContain("Linked");
  });

  test("users: a code works once and expires", () => {
    const rig = team({ ana: { role: "maintainer" } });
    const used = createLinkCode(rig.db, "ana", rig.clock.now());
    expect(redeemLinkCode(rig.db, used, "77", rig.clock.now())?.login).toBe("ana");
    expect(redeemLinkCode(rig.db, used, "78", rig.clock.now())).toBeNull();
    const late = createLinkCode(rig.db, "ana", rig.clock.now());
    expect(redeemLinkCode(rig.db, late, "78", rig.clock.now() + 601)).toBeNull();
    expect(redeemLinkCode(rig.db, "WRONG", "78", rig.clock.now())).toBeNull();
    // Linking again replaces the chat: one chat per person.
    const again = createLinkCode(rig.db, "ana", rig.clock.now());
    redeemLinkCode(rig.db, again, "79", rig.clock.now());
    expect(rig.db.all("SELECT chat FROM tg_links")).toEqual([{ chat: "79" }]);
  });

  test("users: an unlinked chat is ignored", async () => {
    const rig = team({ ana: { role: "maintainer" } });
    rig.say("/status", { chat: "99" });
    await rig.run();
    expect(to(rig, "99")).toEqual([]);
    expect(rig.logs.some((l) => l.includes("ignored update"))).toBe(true);
    expect(rig.actionCalls).toEqual([]);
  });

  test("users: a telegram action follows the role", async () => {
    const rig = team({ ana: { role: "maintainer", name: "Ana Diaz" }, vic: { role: "viewer" } });
    await link(rig, "ana", "77");
    await link(rig, "vic", "78");
    const seen: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: the fake page action records who acted
    (rig.chat as any).d.actions.drop = async () => {
      const a = currentActor();
      seen.push(`${a.login}:${a.via}`);
      return "drop done";
    };
    const w = rig.wait("i-1");
    await rig.run();
    const mine = copyOf(rig, "ana");
    const drop = `d|i-1|${w.view.waitId}`;
    // A viewer's press on a copied button changes nothing.
    rig.press(`D|i-1|${w.view.waitId}`, mine, "78");
    await rig.run();
    expect(seen).toEqual([]);
    expect(rig.answers().at(-1)).toContain("role");
    // A maintainer's press goes through, as that person on Telegram.
    rig.press(drop, mine, "77");
    rig.press(`D|i-1|${w.view.waitId}`, mine, "77");
    await rig.run();
    expect(seen).toEqual(["ana:telegram"]);
  });
});

describe("users: telegram sends a person what waits on them", () => {
  test("users: a decision card goes to maintainers of that repo", async () => {
    const rig = team({
      ana: { role: "maintainer" },
      cat: { role: "contributor" },
      mia: { role: "maintainer", repoRoles: { web: "viewer" } },
      sam: { role: "viewer", repoRoles: { web: "maintainer" } },
    });
    for (const [login, chat] of [
      ["ana", "77"],
      ["cat", "78"],
      ["mia", "79"],
      ["sam", "80"],
    ] as const)
      await link(rig, login, chat);
    rig.wait("i-1");
    await rig.run();
    const got = (chat: string) => to(rig, chat).filter((b) => String(b.text).includes("Add export")).length;
    expect([got("77"), got("78"), got("79"), got("80")]).toEqual([1, 0, 0, 1]);
    expect(got("42")).toBe(1);
  });

  test("users: a viewer gets no telegram message", async () => {
    const rig = team({ vic: { role: "viewer" }, cat: { role: "contributor" }, dan: { role: "contributor" } });
    await link(rig, "vic", "78");
    await link(rig, "cat", "79");
    await link(rig, "dan", "80");
    recordWriter(rig.db, "i-1", "cat", 0);
    rig.wait("i-1", { question: true, actions: ["drop"] }, "answer the question");
    await rig.run();
    const got = (chat: string) => to(rig, chat).filter((b) => String(b.text).includes("Add export")).length;
    // The writer (a contributor) is asked; another contributor and a viewer are not.
    expect([got("78"), got("79"), got("80")]).toEqual([0, 1, 0]);
  });

  test("users: other copies are edited when one person decides", async () => {
    const rig = team({ ana: { role: "maintainer", name: "Ana Diaz" }, bob: { role: "maintainer" } });
    await link(rig, "ana", "77");
    await link(rig, "bob", "78");
    const w = rig.wait("i-1");
    await rig.run();
    const mine = copyOf(rig, "ana");
    const theirs = copyOf(rig, "bob");
    rig.press(`d|i-1|${w.view.waitId}`, mine, "77");
    rig.press(`D|i-1|${w.view.waitId}`, mine, "77");
    await rig.run();
    expect(rig.actionCalls).toContain("drop i-1");
    const edit = rig
      .calls("editMessageText")
      .find((b) => b.message_id === theirs && String(b.chat_id) === "78");
    expect(String(edit?.text)).toContain("handled by Ana Diaz");
    expect((edit!.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([]);
    // A handled copy is not edited again.
    const before = rig.calls("editMessageText").length;
    await rig.run();
    expect(rig.calls("editMessageText").length).toBe(before);
  });
});

describe("users: a removed person's telegram press", () => {
  test("users: a press from a chat unlinked before it was handled does nothing", async () => {
    const rig = team({ ana: { role: "maintainer" } });
    await link(rig, "ana", "77");
    const w = rig.wait("i-1");
    await rig.run();
    const mine = copyOf(rig, "ana");
    // The press is stored while linked, then the person is removed before the next pass handles it.
    rig.press(`d|i-1|${w.view.waitId}`, mine, "77");
    rig.press(`D|i-1|${w.view.waitId}`, mine, "77");
    rig.chat.store(await rig.tg.updates(0, 0));
    rig.db.run("DELETE FROM tg_links WHERE login = 'ana'");
    await rig.run();
    expect(rig.actionCalls.filter((c) => c.startsWith("drop"))).toEqual([]);
  });
});
