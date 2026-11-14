// The people API (USR-14, USR-13, UI-222..224): `/api/me`, `/api/users` and `/api/settings`. Pure of HTTP:
// the server hands it the signed-in person and the parsed body and sends back `{ status, body }`.

import { A0_ADMIN_ONLY } from "../autonomy.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import { CODE_TTL_S, newLinkCode, unlinkTelegram } from "../telegram/people.ts";
import { ACTIONS, type Action, denial, type Role, roleNeeded, type User } from "../users.ts";
import type { Signed } from "./auth.ts";
import { changeSettings, settingsView } from "./settings.ts";
import {
  addUser,
  changeUser,
  getTeam,
  getUser,
  listUsers,
  openSessions,
  removeUser,
  revokeAll,
  revokeSession,
  setDisabled,
  setTeam,
  userEvents,
} from "./store.ts";

export interface UsersApiDeps {
  db: Db;
  config: Config;
  now(): number;
  /** Whether a GitHub account exists (throws when GitHub can't say). */
  exists(login: string): Promise<boolean>;
}

export interface ApiReply {
  status: number;
  body: unknown;
}

const reply = (status: number, body: unknown): ApiReply => ({ status, body });
const refuse = (user: User, action: "manage_users" | "settings"): ApiReply | null => {
  const why = denial(user, action);
  return why ? reply(403, { ok: false, message: why }) : null;
};

/** Who the page is signed in as: no secrets, only the person's own data (UI-223). */
export function meView(d: UsersApiDeps, who: Signed | null) {
  const needs = Object.fromEntries(ACTIONS.map((a) => [a, roleNeeded(a)])) as Record<string, Role>;
  if (!who) {
    // USR-6: without sign-in the page is the owner's.
    const login = d.config.github?.me ?? "owner";
    return { auth: false, login, name: login, role: "admin", repos: {}, telegram: false, needs };
  }
  const row = getUser(d.db, who.user.login);
  return {
    auth: true,
    login: who.user.login,
    name: row?.name || who.user.login,
    role: who.user.role,
    repos: who.user.repos,
    telegram: row?.telegramChat != null,
    needs,
  };
}

/** `GET /api/users` (UI-222, UI-224): people, sessions, team, history. Admin only. */
export function usersView(d: UsersApiDeps, who: Signed) {
  const idle = (d.config.auth?.sessionHours ?? 12) * 3600;
  const now = d.now();
  const sessions = openSessions(d.db, now, idle);
  const people = listUsers(d.db);
  const rows = people.map((p) => ({
    login: p.login,
    name: p.name,
    role: p.role,
    repos: p.repos,
    disabled: p.disabled,
    source: "added",
    addedBy: p.addedBy,
    added: p.added,
    lastSeen: p.lastSeen,
    telegram: p.telegramChat != null,
    sessions: sessions.filter((s) => s.login === p.login),
  }));
  const team = getTeam(d.db);
  const known = new Set(people.map((p) => p.login));
  const members = [...new Set(sessions.filter((s) => !known.has(s.login)).map((s) => s.login))];
  for (const login of members) {
    rows.push({
      login,
      name: "",
      role: team?.role ?? "viewer",
      repos: {},
      disabled: false,
      source: `team ${team?.name ?? ""}`.trim(),
      addedBy: "",
      added: 0,
      lastSeen: null,
      telegram: false,
      sessions: sessions.filter((s) => s.login === login),
    });
  }
  return {
    people: rows,
    team,
    repos: [...d.config.repos.keys()].sort(),
    events: userEvents(d.db, 100),
    current: who.session,
  };
}

/** `POST /api/users`: `{ op, login, role, repos, name, team, session }`. Admin only (USR-14). */
export async function usersPost(d: UsersApiDeps, who: Signed, b: Record<string, unknown>): Promise<ApiReply> {
  const no = refuse(who.user, "manage_users");
  if (no) return no;
  const now = d.now();
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  const role = b.role as Role | undefined;
  const repos = b.repos as Record<string, Role> | undefined;
  const login = str("login");
  try {
    switch (b.op) {
      case "add": {
        if (!(await d.exists(login))) throw new Error(`${login} isn't a GitHub account`);
        addUser(d.db, who.user, login, { role, repos, name: str("name") }, now);
        return reply(200, { ok: true, message: `Added ${login.toLowerCase()}.` });
      }
      case "change":
        changeUser(
          d.db,
          who.user,
          login,
          { role, repos, ...(b.name === undefined ? {} : { name: str("name") }) },
          now,
        );
        return reply(200, { ok: true, message: `Saved ${login.toLowerCase()}.` });
      case "disable":
      case "enable":
        setDisabled(d.db, who.user, login, b.op === "disable", now);
        return reply(200, {
          ok: true,
          message: `${b.op === "disable" ? "Disabled" : "Enabled"} ${login.toLowerCase()}.`,
        });
      case "remove":
        removeUser(d.db, who.user, login, now);
        return reply(200, { ok: true, message: `Removed ${login.toLowerCase()}.` });
      case "team":
        setTeam(d.db, who.user, b.team === null || b.team === "" ? null : { name: str("team"), role }, now);
        return reply(200, { ok: true, message: b.team ? "Team saved." : "Team cleared." });
      case "revoke": {
        const id = Number(b.session);
        if (!Number.isInteger(id)) throw new Error("which session?");
        revokeSession(d.db, who.user, id, now);
        return reply(200, { ok: true, message: "Session ended." });
      }
      case "revoke-all": {
        const keep = login.toLowerCase() === who.user.login ? who.session : undefined;
        const n = revokeAll(d.db, who.user, login, now, keep);
        return reply(200, { ok: true, message: `Ended ${n} session${n === 1 ? "" : "s"}.` });
      }
      default:
        return reply(400, { ok: false, message: "Unknown operation." });
    }
  } catch (e) {
    return reply(422, { ok: false, message: (e as Error).message });
  }
}

/** `POST /api/me/telegram`: `{ op: "link" }` gives a one-time code for this person; `{ op: "unlink" }` ends the link (UI-223, USR-11). */
export function telegramPost(d: UsersApiDeps, who: Signed, b: Record<string, unknown>): ApiReply {
  const row = getUser(d.db, who.user.login);
  if (!row) return reply(422, { ok: false, message: "Ask an admin to add you before linking Telegram." });
  if (b.op === "unlink") {
    unlinkTelegram(d.db, row.login, d.now());
    return reply(200, { ok: true, message: "Telegram unlinked." });
  }
  if (b.op !== "link") return reply(400, { ok: false, message: "Unknown operation." });
  const code = newLinkCode(d.db, row.login, d.now());
  return reply(200, {
    ok: true,
    code,
    minutes: CODE_TTL_S / 60,
    message: `Send /link ${code} to the Towercab bot within ${CODE_TTL_S / 60} minutes.`,
  });
}

/** `GET /api/settings` (admin). */
export function settingsGet(d: UsersApiDeps, who: Signed): ApiReply {
  return refuse(who.user, "settings") ?? reply(200, settingsView(d.config));
}

/** `POST /api/settings`: `{ changes: { "agent.parallel": 3 } }` (admin). */
export function settingsPost(d: UsersApiDeps, who: Signed, b: Record<string, unknown>): ApiReply {
  const no = refuse(who.user, "settings");
  if (no) return no;
  const changes = b.changes;
  if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
    return reply(400, { ok: false, message: "Which settings?" });
  }
  try {
    const message = changeSettings(
      { db: d.db, config: d.config, now: d.now(), by: who.user.login },
      changes as Record<string, unknown>,
    );
    return reply(200, { ok: true, message });
  } catch (e) {
    return reply(422, { ok: false, message: (e as Error).message });
  }
}

/** USR-7: the `can` action each page action needs. Anything not listed needs admin (`settings`). */
const NEEDS: Record<string, Action> = {
  boost: "boost",
  scores: "edit",
  merge: "merge",
  pass: "drop",
  reply: "reply",
  retry: "retry",
  drop: "drop",
  start: "start",
  step: "edit",
  steps: "edit",
  done: "drop",
  secret: "approve",
  "approve-secret": "approve",
  pause: "pause",
  confirm: "confirm",
  resume: "resume",
  accept: "approve",
  close: "drop",
  features: "edit",
  seen: "answer",
  snooze: "answer",
  unsnooze: "answer",
};

/**
 * USR-7: why `user` may not do page action `action` (null when they may). The repo is the intent's (and
 * every other repo it changes), else the body's; an action with neither uses the default role.
 */
export async function gateAction(
  user: User,
  action: string,
  body: { a?: unknown; repo?: unknown },
  intent: string,
  lookup: (id: string) => Promise<{ repo: string; repos?: string[]; a: number | null; a0?: boolean } | null>,
): Promise<string | null> {
  const found = intent ? await lookup(intent).catch(() => null) : null;
  let need: Action = NEEDS[action] ?? "settings";
  if (action === "autonomy") {
    const next = typeof body.a === "number" ? body.a : Number.NaN;
    need = next > (found?.a ?? 0) ? "raise" : "lower";
  }
  const repos = found
    ? [found.repo, ...(found.repos ?? [])]
    : typeof body.repo === "string" && body.repo
      ? [body.repo]
      : [undefined];
  for (const repo of repos) {
    const why = denial(user, need, repo);
    if (why) return why;
  }
  // AUT-25: an a0 intent is decided by admins only (a pause stays open, as in AUT-32).
  if (found?.a0 && user.role !== "admin" && action !== "pause") return A0_ADMIN_ONLY;
  return null;
}
