// The admin's side of the API (USR-14): people, roles, the team, sessions and the settings gate. Each call
// is one JSON body to `POST /api/users` or `POST /api/settings`, checked with `can` by the server first.

import { saveBudgets } from "../budgets.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import {
  addUser,
  changeUser,
  getTeam,
  listUsers,
  openSessions,
  removeUser,
  revokeAll,
  revokeSession,
  type SessionLimits,
  setDisabled,
  setTeam,
  userEvents,
} from "../users-store.ts";

export const SECURITY_SETTING = "this is a security setting: edit the config file";

/** Settings the page may change: the budgets (up to the file's cap), as UI-150 already does. */
const EDITABLE = [/^agent\.(daily|monthly)_budget_usd$/, /^budget\.[^.]+\.(daily|monthly)_usd$/];
/** Security settings: the sandbox and its access rules, the autonomy defaults and caps, sign-in, caps. */
const SECURITY = [
  /^agent\.(network|path|toolchain|env|sandbox\w*)$/,
  /^intents\.issue_a$/,
  /^shadow\./,
  /^auth\./,
  /^github\./,
  /^telegram\./,
  /(^|\.)cap_\w+$/,
  /^autonomy\./,
];

export interface UsersApiDeps {
  db: Db;
  config: Config;
  now(): number;
  /** The login on GitHub, or null when there is none. */
  lookup(login: string): Promise<{ login: string; name: string } | null>;
  limits: SessionLimits;
}

export interface ApiReply {
  status: number;
  body: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fail = (status: number, message: string): ApiReply => ({ status, body: { ok: false, message } });

/** UI-222: everything the admin page shows. */
export function usersView(d: UsersApiDeps) {
  return {
    users: listUsers(d.db),
    team: getTeam(d.db),
    sessions: openSessions(d.db, d.now(), undefined, d.limits),
    events: userEvents(d.db),
  };
}

/** USR-14: one admin action by `by` (a login). Errors come back as 422 with the reason. */
export async function usersAction(d: UsersApiDeps, by: string, keep: string, body: Record<string, unknown>) {
  const op = str(body.op);
  const login = str(body.login);
  const now = d.now();
  try {
    switch (op) {
      case "add": {
        const found = await d.lookup(login);
        if (!found) return fail(422, `${login} isn't a GitHub account`);
        addUser(
          d.db,
          { login: found.login, name: found.name, role: body.role as never, repoRoles: body.repoRoles, by },
          now,
        );
        break;
      }
      case "change":
        changeUser(
          d.db,
          login,
          { role: body.role === undefined ? undefined : (body.role as never), repoRoles: body.repoRoles, by },
          now,
        );
        break;
      case "disable":
      case "enable":
        setDisabled(d.db, login, op === "disable", by, now);
        break;
      case "remove":
        removeUser(d.db, login, by, now);
        break;
      case "team":
        setTeam(d.db, body.team ? { team: str(body.team), role: body.role } : null, by, now);
        break;
      case "revoke":
        if (!revokeSession(d.db, str(body.hash), now)) return fail(404, "That session is already over.");
        break;
      case "revokeAll":
        revokeAll(d.db, login, now, login.toLowerCase() === by.toLowerCase() ? keep : "");
        break;
      default:
        return fail(400, `Unknown users action “${op}”.`);
    }
  } catch (e) {
    return fail(422, (e as Error).message);
  }
  return { status: 200, body: { ok: true, message: "Saved.", ...usersView(d) } } satisfies ApiReply;
}

/** USR-14: change one setting in the config file; a security one is refused with the reason. */
export function changeSetting(d: UsersApiDeps, body: Record<string, unknown>): ApiReply {
  const key = str(body.key);
  if (SECURITY.some((re) => re.test(key))) return fail(403, SECURITY_SETTING);
  const m = EDITABLE.map((re) => re.exec(key)).find((x) => x);
  if (!m) return fail(422, `${key || "That"} can't be changed from the page.`);
  const [scope, period] = key.startsWith("agent.")
    ? ["all", /daily/.test(key) ? "daily" : "monthly"]
    : [key.split(".")[1]!, /daily/.test(key) ? "daily" : "monthly"];
  try {
    const message = saveBudgets(
      { db: d.db, config: d.config, clock: { now: d.now } },
      scope,
      period === "daily" ? body.value : undefined,
      period === "monthly" ? body.value : undefined,
    );
    return { status: 200, body: { ok: true, message } };
  } catch (e) {
    const message = (e as Error).message;
    return fail(message.startsWith(SECURITY_SETTING) ? 403 : 422, message);
  }
}
