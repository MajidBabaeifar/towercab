// Who did what, in words (USR-8, UI-221): the name and channel behind a transition or a decision, and who
// else may decide a repo's waits. Read-only; with `[auth]` unset nothing here is asked.

import type { Db } from "../db.ts";
import { can } from "../users.ts";
import { getUser, listUsers } from "../users-store.ts";

const VIA: Record<string, string> = {
  page: "page",
  github: "GitHub",
  telegram: "Telegram",
  cli: "command line",
};

/** The person's display name, falling back to the login. */
export function nameOf(db: Db, login: string): string {
  return getUser(db, login)?.name || login;
}

/** "Ana · page", or "Towercab" for its own steps; null when no one was recorded. */
export function byLabel(
  db: Db,
  actor: string | null | undefined,
  via: string | null | undefined,
): string | null {
  if (!actor) return null;
  if (actor === "towercab") return "Towercab";
  return via ? `${nameOf(db, actor)} · ${VIA[via] ?? via}` : nameOf(db, actor);
}

const VERB: Record<string, string> = {
  spec_merged: "Merged",
  plan_merged: "Merged",
  code_merged: "Merged",
  closed: "Dropped",
  answered: "Answered",
  feedback: "Sent back",
  retry_fresh: "Started over",
};

/** UI-221: "Approved by Ana · page": the mission's last move that has a recorded actor. */
export function lastBy(db: Db, mission: number): string | null {
  const t = db.get<{ event: string; actor: string; via: string }>(
    "SELECT event, actor, via FROM transitions WHERE mission = ? AND actor != '' ORDER BY id DESC LIMIT 1",
    mission,
  );
  if (!t) return null;
  const who = byLabel(db, t.actor, t.via);
  if (t.actor === "towercab") return who;
  return `${VERB[t.event] ?? "Handled"} by ${who}`;
}

/** UI-221: the names of the people who may decide a wait on `repo` (maintainers and admins there). */
export function decidersOf(db: Db, repo: string): string[] {
  return listUsers(db)
    .filter((u) => !u.disabled && can(u, "merge", repo))
    .map((u) => u.name || u.login);
}
