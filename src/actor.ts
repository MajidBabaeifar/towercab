// Who acted (USR-8): the person and the channel travel with the work in an `AsyncLocalStorage`, set by the
// page's server, the Telegram handler and the GitHub event pass. `machine.apply` and the commands read it.

import { AsyncLocalStorage } from "node:async_hooks";
import type { UserRole } from "./users.ts";

export type Via = "page" | "github" | "telegram" | "cli";

export interface Actor {
  /** The GitHub login, or `towercab` for what Towercab does by itself. */
  login: string;
  /** The display name: GitHub's name, falling back to the login. */
  name: string;
  role: UserRole | null;
  via: Via;
}

const store = new AsyncLocalStorage<Actor>();

/** Towercab's own steps (USR-8). */
export const TOWERCAB: Actor = { login: "towercab", name: "Towercab", role: null, via: "cli" };

/** The owner on the command line, and the actor everywhere while `[auth]` is unset (USR-6). */
export function ownerActor(me: string, via: Via = "cli"): Actor {
  return { login: me, name: me, role: "admin", via };
}

/** Run `fn` as `actor`; everything it awaits sees the same actor. */
export function runAs<T>(actor: Actor, fn: () => T): T {
  return store.run(actor, fn);
}

/** The actor of the running work; none set means Towercab's own step. */
export function currentActor(): Actor {
  return store.getStore() ?? TOWERCAB;
}

/** "<name> · <via>" as the cards and timeline show it (USR-8). */
export function actorLabel(a: Pick<Actor, "login" | "name" | "via">): string {
  return a.login === TOWERCAB.login ? "Towercab" : `${a.name || a.login} · ${a.via}`;
}

/** The `actor` and `via` columns of a transition or command row: Towercab's own steps have no channel. */
export function actorColumns(a: Actor = currentActor()): [string, string] {
  return a.login === TOWERCAB.login ? [TOWERCAB.login, ""] : [a.login, a.via];
}

const VIAS: readonly string[] = ["page", "github", "telegram", "cli"];

/** An actor read back from a row's `actor` and `via` (empty: none recorded). */
export function actorOfRow(login: string, via: string): Actor | null {
  if (!login || login === TOWERCAB.login) return null;
  return { login, name: login, role: null, via: (VIAS.includes(via) ? via : "cli") as Via };
}
