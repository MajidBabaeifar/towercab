// USR-2: who a GitHub login is to this Towercab: a user's row, else the named team's role.
// Shared by sign-in (src/users/auth.ts) and the GitHub event readers (src/loop.ts).

import type { Db } from "../db.ts";
import type { User } from "../users.ts";
import { getTeam, getUser } from "./store.ts";

/** USR-2: a team membership is checked again after this many seconds. */
export const TEAM_RECHECK_S = 600;

export interface PeopleDeps {
  db: Db;
  now(): number;
  /** Whether `login` is in the GitHub team `org/team`; throws when GitHub can't say. */
  inTeam(team: string, login: string): Promise<boolean>;
}

export class People {
  private readonly teamCache = new Map<string, { at: number; member: boolean }>();
  private readonly d: PeopleDeps;

  constructor(d: PeopleDeps) {
    this.d = d;
  }

  /**
   * USR-2: the person a login stands for now: their row (a disabled one is nobody), else the named team's
   * role while they are in it. `fresh` forces a membership check; otherwise an answer under ten minutes old
   * stands, and when GitHub can't answer the last one does.
   */
  async resolve(login: string, fresh = false): Promise<User | null> {
    const row = getUser(this.d.db, login);
    if (row) return row.disabled ? null : row;
    const team = getTeam(this.d.db);
    if (!team) return null;
    const who = login.toLowerCase();
    const now = this.d.now();
    const hit = this.teamCache.get(who);
    let member = hit?.member ?? false;
    if (fresh || !hit || now - hit.at >= TEAM_RECHECK_S) {
      try {
        member = await this.d.inTeam(team.name, who);
        this.teamCache.set(who, { at: now, member });
      } catch {
        // GitHub is unreachable: the last answer stands (none yet means no).
      }
    }
    return member ? { login: who, role: team.role, repos: {} } : null;
  }
}
