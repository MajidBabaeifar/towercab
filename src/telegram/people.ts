// Telegram for a team (USR-11, USR-12): one-time link codes that tie a chat to a person, and which linked
// chats a wait goes to. The rules are `can` (USR-1); nothing here knows a role by name except "viewer gets none".

import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import { peopleOf } from "../intent-people.ts";
import { can, roleOn } from "../users.ts";
import { getUser, type StoredUser } from "../users-store.ts";

/** USR-11: a code lives 10 minutes. */
export const LINK_CODE_SECS = 600;

/** A fresh single-use code for `login`; an earlier open one stops working. */
export function createLinkCode(db: Db, login: string, now: number): string {
  const user = getUser(db, login);
  if (!user || user.disabled) throw new Error("Only a person an admin added can link Telegram.");
  const code = randomBytes(5).toString("hex").toUpperCase();
  db.tx(() => {
    db.run("DELETE FROM tg_link_codes WHERE login = ? AND used_at IS NULL", user.login.toLowerCase());
    db.run(
      "INSERT INTO tg_link_codes (code, login, expires) VALUES (?, ?, ?)",
      code,
      user.login.toLowerCase(),
      now + LINK_CODE_SECS,
    );
  });
  return code;
}

/** USR-11: ties `chat` to the code's person (one chat each: linking again replaces); null when it can't. */
export function redeemLinkCode(db: Db, code: string, chat: string, now: number): StoredUser | null {
  return db.tx(() => {
    const row = db.get<{ login: string; expires: number; used_at: number | null }>(
      "SELECT login, expires, used_at FROM tg_link_codes WHERE code = ?",
      code.trim().toUpperCase(),
    );
    if (!row || row.used_at !== null || row.expires <= now) return null;
    const user = getUser(db, row.login);
    if (!user || user.disabled) return null;
    db.run("UPDATE tg_link_codes SET used_at = ? WHERE code = ?", now, code.trim().toUpperCase());
    db.run("DELETE FROM tg_links WHERE login = ? OR chat = ?", row.login, chat);
    db.run("INSERT INTO tg_links (login, chat, linked) VALUES (?, ?, ?)", row.login, chat, now);
    return user;
  });
}

/** The enabled person this chat is linked to, or null (an unlinked chat is ignored). */
export function linkedUser(db: Db, chat: string): StoredUser | null {
  if (!chat) return null;
  const l = db.get<{ login: string }>("SELECT login FROM tg_links WHERE chat = ?", chat);
  const u = l ? getUser(db, l.login) : null;
  return u && !u.disabled ? u : null;
}

/** The chat a person linked, or null. */
export function chatOf(db: Db, login: string): string | null {
  return (
    db.get<{ chat: string }>("SELECT chat FROM tg_links WHERE login = ?", login.toLowerCase())?.chat ?? null
  );
}

/** What a wait needs to find its recipients. */
export interface Asked {
  intent: string;
  repo: string;
  question: boolean;
  onlyYou: boolean;
}

/**
 * USR-12: the linked people a wait goes to: a decision to the maintainers and admins of its repo, a question
 * also to the person who wrote the intent (unless viewer). The owner's own chat is told by `tg_cards`.
 */
export function recipientsOf(db: Db, ask: Asked, ownerChat: string): { user: StoredUser; chat: string }[] {
  const writer = peopleOf(db, ask.intent)?.writer ?? null;
  const out: { user: StoredUser; chat: string }[] = [];
  for (const l of db.all<{ login: string; chat: string }>(
    "SELECT login, chat FROM tg_links ORDER BY login",
  )) {
    if (l.chat === ownerChat) continue;
    const user = getUser(db, l.login);
    if (!user || user.disabled) continue;
    const role = roleOn(user, ask.repo);
    if (role === "viewer") continue;
    if (ask.onlyYou && role !== "admin") continue;
    const decides = can(user, "merge", ask.repo);
    const writes = writer === user.login.toLowerCase() && can(user, "answer", ask.repo);
    if (ask.question ? decides || writes : decides) out.push({ user, chat: l.chat });
  }
  return out;
}
