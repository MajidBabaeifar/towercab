// The people table and their sessions (USR-2, USR-4, USR-6, USR-14). Everything here is synchronous SQL on
// one `Db`; each change to a person is also written to `user_events`. Times are seconds, as the clock gives.

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.ts";
import { checkRepoRoles, checkTeamRole, isRole, leavesAdmin, type Person, type UserRole } from "./users.ts";

/** A row of `users`, parsed. */
export interface StoredUser extends Person {
  name: string;
  addedBy: string;
  added: number;
  lastSeen: number | null;
}

interface UserRow {
  login: string;
  name: string;
  role: string;
  repo_roles: string;
  added_by: string;
  added: number;
  disabled_at: number | null;
  last_seen: number | null;
}

const key = (login: string) => login.toLowerCase();

function parse(r: UserRow): StoredUser {
  let repoRoles: Record<string, UserRole> = {};
  try {
    repoRoles = checkRepoRoles(JSON.parse(r.repo_roles));
  } catch {
    // A damaged value gives no repo roles: the default role applies.
  }
  return {
    login: r.login,
    name: r.name,
    role: r.role as UserRole,
    repoRoles,
    disabled: r.disabled_at !== null,
    addedBy: r.added_by,
    added: r.added,
    lastSeen: r.last_seen,
  };
}

export function getUser(db: Db, login: string): StoredUser | null {
  const r = db.get<UserRow>("SELECT * FROM users WHERE login = ?", key(login));
  return r ? parse(r) : null;
}

export function listUsers(db: Db): StoredUser[] {
  return db.all<UserRow>("SELECT * FROM users ORDER BY login").map(parse);
}

/** USR-14: who changed what, when; newest first. */
export interface UserEvent {
  id: number;
  at: number;
  actor: string;
  what: string;
  login: string;
  detail: string;
}

export function userEvents(db: Db, limit = 200): UserEvent[] {
  return db.all<UserEvent>("SELECT * FROM user_events ORDER BY id DESC LIMIT ?", limit);
}

function record(db: Db, at: number, actor: string, what: string, login = "", detail = ""): void {
  db.run(
    "INSERT INTO user_events (at, actor, what, login, detail) VALUES (?, ?, ?, ?, ?)",
    at,
    actor,
    what,
    login,
    detail,
  );
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** USR-14: add a person. The caller has checked on GitHub that the login exists. */
export function addUser(
  db: Db,
  o: { login: string; name?: string; role: UserRole; repoRoles?: unknown; by: string },
  now: number,
): StoredUser {
  if (!LOGIN.test(o.login)) throw new Error(`"${o.login}" isn't a GitHub login`);
  if (!isRole(o.role)) throw new Error(`"${String(o.role)}" isn't a role`);
  const repoRoles = checkRepoRoles(o.repoRoles);
  return db.tx(() => {
    if (getUser(db, o.login)) throw new Error(`${o.login} is already added`);
    db.run(
      "INSERT INTO users (login, name, role, repo_roles, added_by, added) VALUES (?, ?, ?, ?, ?, ?)",
      key(o.login),
      o.name ?? "",
      o.role,
      JSON.stringify(repoRoles),
      o.by,
      now,
    );
    record(db, now, o.by, "added", key(o.login), JSON.stringify({ role: o.role, repoRoles }));
    return getUser(db, o.login)!;
  });
}

/** USR-6: with no person at all, `me` becomes the first admin; otherwise nothing happens. */
export function seedOwner(db: Db, me: string, now: number): boolean {
  if (!me) return false;
  return db.tx(() => {
    if (db.get("SELECT 1 AS x FROM users LIMIT 1")) return false;
    addUser(db, { login: me, role: "admin", by: "towercab" }, now);
    return true;
  });
}

const noLastAdmin = (db: Db, login: string, after: { role: UserRole } | null) => {
  if (!leavesAdmin(listUsers(db), login, after)) {
    throw new Error("this is the last admin: add another admin first");
  }
};

/** USR-14: change a person's default role and/or repo roles. */
export function changeUser(
  db: Db,
  login: string,
  o: { role?: UserRole; repoRoles?: unknown; name?: string; by: string },
  now: number,
): StoredUser {
  return db.tx(() => {
    const u = getUser(db, login);
    if (!u) throw new Error(`${login} isn't a user`);
    const role = o.role ?? u.role;
    if (!isRole(role)) throw new Error(`"${String(role)}" isn't a role`);
    const repoRoles = o.repoRoles === undefined ? (u.repoRoles ?? {}) : checkRepoRoles(o.repoRoles);
    if (role !== u.role) noLastAdmin(db, login, { role });
    db.run(
      "UPDATE users SET role = ?, repo_roles = ?, name = ? WHERE login = ?",
      role,
      JSON.stringify(repoRoles),
      o.name ?? u.name,
      key(login),
    );
    record(db, now, o.by, "changed", key(login), JSON.stringify({ role, repoRoles }));
    return getUser(db, login)!;
  });
}

/** USR-14: disable (or enable again) a person; disabling ends their sessions. */
export function setDisabled(db: Db, login: string, disabled: boolean, by: string, now: number): void {
  db.tx(() => {
    if (!getUser(db, login)) throw new Error(`${login} isn't a user`);
    if (disabled) {
      noLastAdmin(db, login, null);
      revokeAll(db, login, now);
    }
    db.run("UPDATE users SET disabled_at = ? WHERE login = ?", disabled ? now : null, key(login));
    record(db, now, by, disabled ? "disabled" : "enabled", key(login));
  });
}

/** USR-4, USR-14: remove a person and end every session of theirs. */
export function removeUser(db: Db, login: string, by: string, now: number): void {
  db.tx(() => {
    if (!getUser(db, login)) throw new Error(`${login} isn't a user`);
    noLastAdmin(db, login, null);
    revokeAll(db, login, now);
    db.run("DELETE FROM tg_links WHERE login = ?", key(login));
    db.run("DELETE FROM users WHERE login = ?", key(login));
    record(db, now, by, "removed", key(login));
  });
}

/** USR-2: the GitHub team (`org/team`) and the role its members get; null: none named. */
export interface TeamSetting {
  team: string;
  role: UserRole;
}

const TEAM_KEY = "auth:team";

export function getTeam(db: Db): TeamSetting | null {
  const v = db.meta(TEAM_KEY);
  return v === null ? null : (JSON.parse(v) as TeamSetting);
}

/** USR-2, USR-14: name the team, or clear it with null. A role above contributor is refused. */
export function setTeam(db: Db, t: { team: string; role?: unknown } | null, by: string, now: number): void {
  db.tx(() => {
    if (t === null) {
      db.delMeta(TEAM_KEY);
      record(db, now, by, "team cleared");
      return;
    }
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(t.team)) throw new Error("the team is written org/team");
    const role = checkTeamRole(t.role ?? "viewer");
    db.setMeta(TEAM_KEY, JSON.stringify({ team: t.team, role } satisfies TeamSetting));
    record(db, now, by, "team named", "", `${t.team} as ${role}`);
  });
}

/** USR-4: how long a session lasts (`[auth].session_hours`, `[auth].session_days`). */
export interface SessionLimits {
  idleSecs: number;
  maxSecs: number;
}

export const DEFAULT_LIMITS: SessionLimits = { idleSecs: 12 * 3600, maxSecs: 7 * 86_400 };

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** USR-4: start a session; the token goes to the browser, only its hash is kept. */
export function createSession(db: Db, login: string, now: number, limits = DEFAULT_LIMITS): string {
  const token = randomBytes(32).toString("hex");
  db.run(
    "INSERT INTO sessions (hash, login, created, last_seen, expires) VALUES (?, ?, ?, ?, ?)",
    hashToken(token),
    key(login),
    now,
    now,
    now + limits.maxSecs,
  );
  return token;
}

/**
 * USR-4: the person behind a token, or null when it is unknown, revoked, idle too long, past its last day, or
 * the person is gone or disabled. The person is read now, so a role change applies at the next request.
 */
export function sessionUser(db: Db, token: string, now: number, limits = DEFAULT_LIMITS): StoredUser | null {
  const s = db.get<{ login: string; last_seen: number; expires: number; revoked_at: number | null }>(
    "SELECT login, last_seen, expires, revoked_at FROM sessions WHERE hash = ?",
    hashToken(token),
  );
  if (!s || s.revoked_at !== null || now >= s.expires || now - s.last_seen >= limits.idleSecs) return null;
  const u = getUser(db, s.login);
  if (!u || u.disabled) return null;
  db.run("UPDATE sessions SET last_seen = ? WHERE hash = ?", now, hashToken(token));
  db.run("UPDATE users SET last_seen = ? WHERE login = ?", now, key(u.login));
  return u;
}

/** An open session, for the admin page (UI-224). The hash is its handle; the token is never shown. */
export interface SessionRow {
  hash: string;
  login: string;
  created: number;
  lastSeen: number;
}

export function openSessions(db: Db, now: number, login?: string, limits = DEFAULT_LIMITS): SessionRow[] {
  return db
    .all<{ hash: string; login: string; created: number; last_seen: number }>(
      "SELECT hash, login, created, last_seen FROM sessions WHERE revoked_at IS NULL AND expires > ? AND last_seen > ? AND (? = '' OR login = ?) ORDER BY created",
      now,
      now - limits.idleSecs,
      login ? key(login) : "",
      login ? key(login) : "",
    )
    .map((r) => ({ hash: r.hash, login: r.login, created: r.created, lastSeen: r.last_seen }));
}

/** USR-4: end one session by its hash. */
export function revokeSession(db: Db, hash: string, now: number): boolean {
  return (
    db.run("UPDATE sessions SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL", now, hash).changes > 0
  );
}

/** USR-4: end every session of a person, except the one whose hash is `keep` (an admin's own, UI-224). */
export function revokeAll(db: Db, login: string, now: number, keep = ""): number {
  return db.run(
    "UPDATE sessions SET revoked_at = ? WHERE login = ? AND revoked_at IS NULL AND hash != ?",
    now,
    key(login),
    keep,
  ).changes;
}
