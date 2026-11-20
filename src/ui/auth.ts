// Sign-in (USR-2, USR-3, USR-4): the OAuth round trip, who may get a session, and the team re-check.

import { randomBytes } from "node:crypto";
import type { Db } from "../db.ts";
import type { Http } from "../github/app.ts";
import { authorizeUrl, exchangeCode, fetchLogin, inTeam, type OAuthApp } from "../github/oauth.ts";
import {
  addUser,
  changeUser,
  createSession,
  getTeam,
  getUser,
  hashToken,
  removeUser,
  revokeAll,
  type SessionLimits,
  type StoredUser,
} from "../users-store.ts";

/** How long a sign-in may take between the redirect and the callback. */
export const STATE_SECS = 600;
/** USR-2: how often a team member's membership is checked while they are signed in. */
export const TEAM_RECHECK_SECS = 600;
export const UNKNOWN_ACCOUNT = "This Towercab doesn't know your GitHub account. Ask an admin to add you.";

const TEAM_BY = "team:";

export type SignIn =
  | { ok: true; token: string; user: StoredUser }
  | { ok: false; reason: string; login?: string };

export class Auth {
  private db: Db;
  private app: OAuthApp;
  private http: Http;
  private limits: SessionLimits;
  private states = new Map<string, number>();
  /** The user's GitHub token of each team-derived session, in memory only; keyed by the session hash. */
  private tokens = new Map<string, { token: string; checked: number }>();

  constructor(o: { db: Db; app: OAuthApp; http: Http; limits: SessionLimits }) {
    this.db = o.db;
    this.app = o.app;
    this.http = o.http;
    this.limits = o.limits;
  }

  /** The address to send the browser to, with a fresh single-use `state`. */
  start(now: number): { url: string; state: string } {
    for (const [s, at] of this.states) if (now - at > STATE_SECS) this.states.delete(s);
    const state = randomBytes(16).toString("hex");
    this.states.set(state, now);
    return { url: authorizeUrl(this.app, state), state };
  }

  /** USR-3: finish a sign-in. A wrong or reused `state` is refused before GitHub is asked anything. */
  async callback(code: string, state: string, now: number): Promise<SignIn> {
    const at = this.states.get(state);
    this.states.delete(state);
    if (at === undefined || now - at > STATE_SECS) {
      return { ok: false, reason: "this sign-in link expired or isn't ours: start again" };
    }
    let token: string;
    let login: string;
    try {
      token = await exchangeCode(this.http, this.app, code);
      login = await fetchLogin(this.http, this.app, token);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    let user = getUser(this.db, login);
    let viaTeam = false;
    if (!user) {
      const team = getTeam(this.db);
      if (team) {
        try {
          if (await inTeam(this.http, this.app, token, team.team, login)) {
            user = addUser(this.db, { login, role: team.role, by: `${TEAM_BY}${team.team}` }, now);
            viaTeam = true;
          }
        } catch (e) {
          return { ok: false, reason: (e as Error).message };
        }
      }
    } else if (user.addedBy.startsWith(TEAM_BY)) {
      viaTeam = true;
    }
    if (!user || user.disabled) return { ok: false, reason: UNKNOWN_ACCOUNT, login };
    if (viaTeam) {
      const left = await this.syncTeam(user, token, now);
      if (left) return { ok: false, reason: UNKNOWN_ACCOUNT, login };
      user = getUser(this.db, login) ?? user;
    }
    const session = createSession(this.db, login, now, this.limits);
    if (viaTeam) this.tokens.set(hashToken(session), { token, checked: now });
    return { ok: true, token: session, user };
  }

  /**
   * USR-2: for a person who is in only through the team, checks the membership at most every 10 minutes.
   * Returns true when they have left (their row and sessions are gone). A row an admin added is never touched.
   */
  async recheck(session: string, user: StoredUser, now: number): Promise<boolean> {
    if (!user.addedBy.startsWith(TEAM_BY)) return false;
    const h = hashToken(session);
    const held = this.tokens.get(h);
    if (held && now - held.checked < TEAM_RECHECK_SECS) return false;
    // After a restart the user's token is gone, so a team member signs in again.
    if (!held) return this.drop(user, now);
    held.checked = now;
    return this.syncTeam(user, held.token, now);
  }

  private async syncTeam(user: StoredUser, token: string, now: number): Promise<boolean> {
    const team = getTeam(this.db);
    let member = false;
    if (team) {
      try {
        member = await inTeam(this.http, this.app, token, team.team, user.login);
      } catch {
        member = true; // GitHub failing is not proof they left; the next check tries again
      }
    }
    if (!team || !member) return this.drop(user, now);
    if (team.role !== user.role) changeUser(this.db, user.login, { role: team.role, by: "towercab" }, now);
    return false;
  }

  private drop(user: StoredUser, now: number): true {
    revokeAll(this.db, user.login, now);
    removeUser(this.db, user.login, "towercab", now);
    return true;
  }
}
