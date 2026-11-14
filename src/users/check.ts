// USR-9: which GitHub logins count on one mission. The readers in src/github/events.ts ask `may`, which
// is synchronous, so the people are looked up first (team membership is a GitHub call).

import { type Action, can, type User } from "../users.ts";
import type { People } from "./people.ts";

/** What a login did: an approving review, feedback (a comment or a review's words), or a command like `/retry`. */
export type What = "approve" | "feedback" | "command";

export interface LoginCheck {
  may(login: string, what: What): boolean;
  /** The role-given reason a known login doesn't count, for the note on the timeline; null when it counts or is unknown. */
  contributor(login: string): boolean;
}

const ACTION: Record<What, Action> = { approve: "approve", feedback: "reply", command: "retry" };

export interface CheckInput {
  /** `[github].me`: the owner's login on this machine always counts (the page acts through it). */
  me: string;
  /** The mission's repos (the lead first): the role must hold on every one. */
  repos: string[];
  /** The login of the intent's writer (AUT-23), when known. */
  writer: string | null;
  /** AUT-25: an a0 intent is decided by admins only. */
  adminOnly?: boolean;
  /** The mission waits on a question (USR-9: its writer's contributor comment answers it). */
  asking: boolean;
}

/** Look every author up once, then answer synchronously. */
export async function loginCheck(
  people: People,
  input: CheckInput,
  authors: Iterable<string>,
): Promise<LoginCheck> {
  const known = new Map<string, User | null>();
  for (const a of new Set([...authors].map((x) => x.toLowerCase()))) {
    if (a === input.me.toLowerCase()) continue;
    known.set(a, await people.resolve(a).catch(() => null));
  }
  const me = input.me.toLowerCase();
  const allowed = (u: User, action: Action) =>
    (!input.adminOnly || u.role === "admin") && input.repos.every((r) => can(u, action, r));
  return {
    may(login, what) {
      const who = login.toLowerCase();
      if (who === "") return false;
      if (who === me) return true;
      const u = known.get(who);
      if (!u) return false;
      if (allowed(u, ACTION[what])) return true;
      // A contributor answers the question asked of them: only their own intent, only while it waits.
      return (
        what === "feedback" && input.asking && input.writer?.toLowerCase() === who && allowed(u, "answer")
      );
    },
    contributor(login) {
      const u = known.get(login.toLowerCase());
      return !!u && allowed(u, "create") && !allowed(u, "reply");
    },
  };
}
