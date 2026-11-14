// The people Towercab knows (USR-2, USR-6, USR-14): rows in `users`, every change logged in `user_events`.
// Sync on purpose (`Db.tx` is); each change takes the admin who makes it and refuses anyone else.

import type { Db } from "../db.ts";
import { can, isRole, ROLES, type Role, type User } from "../users.ts";

interface UserRow {
  login: string;
  name: string;
  role: string;
  repos: string;
  added_by: string;
  added: number;
  disabled_at: number | null;
  last_seen: number | null;
  telegram_chat: string | null;
}

/** A person as the admin page lists them (USR-14, UI-222). */
export interface PersonRow extends User {
  name: string;
  addedBy: string;
  added: number;
  disabledAt: number | null;
  lastSeen: number | null;
}

/** What an admin may set when adding or changing a person. */
export interface UserInput {
  role?: Role;
  repos?: Record<string, Role>;
  name?: string;
}

export interface UserEvent {
  id: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

const lower = (s: string) => s.trim().toLowerCase();

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
export function isLogin(s: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(s);
}

function toUser(r: UserRow): PersonRow {
  const repos: Record<string, Role> = {};
  try {
    for (const [k, v] of Object.entries(JSON.parse(r.repos) as Record<string, unknown>)) {
      if (isRole(v)) repos[k] = v;
    }
  } catch {
    // A damaged value counts as no per-repo roles: the default role applies.
  }
  return {
    login: r.login,
    name: r.name,
    role: isRole(r.role) ? r.role : "viewer",
    repos,
    disabled: r.disabled_at !== null,
    addedBy: r.added_by,
    added: r.added,
    disabledAt: r.disabled_at,
    lastSeen: r.last_seen,
  };
}

/** The person with this GitHub login (any case), disabled ones included; null when unknown. */
export function getUser(db: Db, login: string): PersonRow | null {
  const r = db.get<UserRow>("SELECT * FROM users WHERE login = ?", lower(login));
  return r ? toUser(r) : null;
}

export function listUsers(db: Db): PersonRow[] {
  return db.all<UserRow>("SELECT * FROM users ORDER BY login").map(toUser);
}

function enabledAdmins(db: Db): string[] {
  return listUsers(db)
    .filter((u) => u.role === "admin" && !u.disabled)
    .map((u) => u.login);
}

/** USR-14: the log of changes, newest first. */
export function userEvents(db: Db, limit = 100): UserEvent[] {
  return db.all<UserEvent>("SELECT * FROM user_events ORDER BY id DESC LIMIT ?", limit);
}

function record(db: Db, now: number, actor: string, action: string, target: string, detail: string): void {
  db.run(
    "INSERT INTO user_events (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
    now,
    actor,
    action,
    target,
    detail,
  );
}

/**
 * USR-6: with `[auth]` set and nobody known yet, `[github].me` becomes the first admin, so an admin can
 * always sign in. True when it created the row.
 */
export function ensureFirstAdmin(db: Db, me: string, now: number): boolean {
  if (!isLogin(me)) return false;
  return db.tx(() => {
    if (listUsers(db).length > 0) return false;
    db.run(
      "INSERT INTO users (login, role, added_by, added) VALUES (?, 'admin', 'towercab', ?)",
      lower(me),
      now,
    );
    record(db, now, "towercab", "add", lower(me), "admin: the owner, first start");
    return true;
  });
}

function requireAdmin(by: User): void {
  if (!can(by, "manage_users")) throw new Error("only an admin manages users");
}

function checkRepos(repos: Record<string, Role> | undefined): Record<string, Role> {
  const out: Record<string, Role> = {};
  for (const [repo, role] of Object.entries(repos ?? {})) {
    if (!isRole(role)) throw new Error(`${role} isn't a role (${ROLES.join(", ")})`);
    // USR-5: admin is global, never per repo.
    if (role === "admin") throw new Error("admin applies to every repo: set it as the default role");
    out[repo] = role;
  }
  return out;
}

const summary = (role: Role, repos: Record<string, Role>) => {
  const per = Object.entries(repos).map(([r, v]) => `${r}: ${v}`);
  return per.length ? `${role} (${per.join(", ")})` : role;
};

/** USR-14: add a person. The caller checks the login exists on GitHub first. */
export function addUser(db: Db, by: User, login: string, input: UserInput, now: number): PersonRow {
  requireAdmin(by);
  const who = lower(login);
  if (!isLogin(who)) throw new Error(`${login} isn't a GitHub login`);
  const role = input.role ?? "viewer";
  if (!isRole(role)) throw new Error(`${role} isn't a role (${ROLES.join(", ")})`);
  const repos = checkRepos(input.repos);
  return db.tx(() => {
    if (getUser(db, who)) throw new Error(`${who} is already added`);
    db.run(
      "INSERT INTO users (login, name, role, repos, added_by, added) VALUES (?, ?, ?, ?, ?, ?)",
      who,
      input.name ?? "",
      role,
      JSON.stringify(repos),
      by.login,
      now,
    );
    record(db, now, by.login, "add", who, summary(role, repos));
    return getUser(db, who)!;
  });
}

/** USR-14: change a person's default role, repo roles or name. The last enabled admin stays admin (USR-6). */
export function changeUser(db: Db, by: User, login: string, input: UserInput, now: number): PersonRow {
  requireAdmin(by);
  const who = lower(login);
  return db.tx(() => {
    const cur = getUser(db, who);
    if (!cur) throw new Error(`${who} isn't a user`);
    const role = input.role ?? cur.role;
    if (!isRole(role)) throw new Error(`${role} isn't a role (${ROLES.join(", ")})`);
    const repos = input.repos === undefined ? cur.repos : checkRepos(input.repos);
    if (cur.role === "admin" && !cur.disabled && role !== "admin" && enabledAdmins(db).length < 2) {
      throw new Error("can't change the last admin: add another admin first");
    }
    db.run(
      "UPDATE users SET name = ?, role = ?, repos = ? WHERE login = ?",
      input.name ?? cur.name,
      role,
      JSON.stringify(repos),
      who,
    );
    record(db, now, by.login, "change", who, summary(role, { ...repos }));
    return getUser(db, who)!;
  });
}

/** USR-4: every open session of a person ends. Returns how many. */
export function revokeSessions(db: Db, login: string, now: number): number {
  return db.run(
    "UPDATE sessions SET revoked_at = ? WHERE login = ? AND revoked_at IS NULL",
    now,
    lower(login),
  ).changes;
}

/** USR-14: switch a person off (`disabled: true`) or back on. Their sessions end when they are switched off. */
export function setDisabled(db: Db, by: User, login: string, disabled: boolean, now: number): PersonRow {
  requireAdmin(by);
  const who = lower(login);
  return db.tx(() => {
    const cur = getUser(db, who);
    if (!cur) throw new Error(`${who} isn't a user`);
    if (disabled && cur.role === "admin" && !cur.disabled && enabledAdmins(db).length < 2) {
      throw new Error("can't disable the last admin: add another admin first");
    }
    db.run("UPDATE users SET disabled_at = ? WHERE login = ?", disabled ? now : null, who);
    if (disabled) revokeSessions(db, who, now);
    record(db, now, by.login, disabled ? "disable" : "enable", who, "");
    return getUser(db, who)!;
  });
}

/** USR-14, USR-4: remove a person; all their sessions end. The last enabled admin can't be removed (USR-6). */
export function removeUser(db: Db, by: User, login: string, now: number): void {
  requireAdmin(by);
  const who = lower(login);
  db.tx(() => {
    const cur = getUser(db, who);
    if (!cur) throw new Error(`${who} isn't a user`);
    if (cur.role === "admin" && !cur.disabled && enabledAdmins(db).length < 2) {
      throw new Error("can't remove the last admin: add another admin first");
    }
    revokeSessions(db, who, now);
    db.run("DELETE FROM users WHERE login = ?", who);
    record(db, now, by.login, "remove", who, "");
  });
}
