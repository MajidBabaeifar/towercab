// USR-9: whose GitHub words count on one intent. With `[auth]` set, the author's login is looked up in the
// people (USR-2) and `can` decides instead of the owner's login (PIP-44). One value per intent and repo.

import type { Db } from "../db.ts";
import { can, roleOn } from "../users.ts";
import { getUser, type StoredUser } from "../users-store.ts";

export interface Voices {
  /** A maintainer or admin of the intent's repo: their approval, feedback and `/retry` count. */
  decides(author: string): boolean;
  /** The person who wrote the intent, if they are not a viewer: their comment answers an open question. */
  answers(author: string): boolean;
  /** The display name of a known, enabled person (for a timeline note), else null. */
  nameOf(author: string): string | null;
}

/** Who may speak on `intent` in `repo`; `user` looks a login up (the team role included, USR-2). */
export function voicesFor(
  db: Db,
  repo: string,
  intent: string,
  user: (login: string) => StoredUser | null = (l) => getUser(db, l),
  /** The repo's full name as roles name it (`owner/name`). */
  repoFull = repo,
  /** AUT-25: an a0 intent is decided by an admin only. */
  adminOnly = false,
): Voices {
  const writer = db.get<{ writer: string | null }>(
    "SELECT writer FROM intent_people WHERE intent = ?",
    intent,
  )?.writer;
  const known = (login: string) => {
    const u = user(login);
    return u && !u.disabled ? u : null;
  };
  return {
    decides: (a) => {
      const u = known(a);
      return can(u, "approve", repoFull) && (!adminOnly || roleOn(u!, repoFull) === "admin");
    },
    answers: (a) => {
      const u = known(a);
      return (
        u !== null &&
        (!adminOnly || roleOn(u, repoFull) === "admin") &&
        !!writer &&
        writer.toLowerCase() === a.toLowerCase() &&
        can(u, "answer", repoFull)
      );
    },
    nameOf: (a) => known(a)?.name || known(a)?.login || null,
  };
}
