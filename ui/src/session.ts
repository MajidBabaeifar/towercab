// Who is signed in (UI-219, UI-220): `/api/me`, the role-aware checks every button asks, and the signed-out
// state a 401 from any call sets. With no `[auth]` the server answers as the owner (an admin), so every
// check passes and nothing here shows.

import { useEffect, useState } from "preact/hooks";
import type { ActionKey } from "../../src/ui/view.ts";
import { can, needsText, type UserAction, type UserRole } from "../../src/users.ts";

export interface Me {
  auth: boolean;
  login: string;
  name: string;
  role: UserRole;
  repoRoles: Record<string, UserRole>;
  telegram?: { available: boolean; linked: boolean };
}

export type SessionState = "loading" | "in" | "out";

export const SIGNED_OUT = "towercab:signed-out";

let me: Me | null = null;
let state: SessionState = "loading";
const subs = new Set<() => void>();

function set(next: SessionState, who: Me | null) {
  state = next;
  me = who;
  for (const s of subs) s();
}

/** Read `/api/me` again (after sign-in, a link, or when asked). */
export async function loadMe(): Promise<void> {
  try {
    const r = await fetch("/api/me", { headers: { Accept: "application/json" } });
    if (r.status === 401) return set("out", null);
    if (r.ok) return set("in", (await r.json()) as Me);
  } catch {
    // Offline: keep what we know; the page's own banner says Towercab can't be reached.
  }
  if (state === "loading") set("in", null);
}

addEventListener(SIGNED_OUT, () => set("out", null));

export function useSession(): { me: Me | null; state: SessionState } {
  const [, redraw] = useState(0);
  useEffect(() => {
    const on = () => redraw((n) => n + 1);
    subs.add(on);
    if (state === "loading") void loadMe();
    return () => {
      subs.delete(on);
    };
  }, []);
  return { me, state };
}

export const useMe = (): Me | null => useSession().me;

/** UI-220: which permission each of a card's action buttons needs. */
export const NEED: Record<ActionKey, UserAction> = {
  merge: "merge",
  pass: "drop",
  reply: "reply",
  retry: "retry",
  drop: "drop",
  confirm: "confirm",
};

/** Whether `who` may do `action` on `repo`, and the tooltip when not. With no sign-in everything is allowed. */
export function allows(who: Me | null, action: UserAction, repo: string): { ok: boolean; why: string } {
  if (!who || !who.auth) return { ok: true, why: "" };
  return can(who, action, repo) ? { ok: true, why: "" } : { ok: false, why: needsText(who, action, repo) };
}

/** UI-220: a viewer sees no action buttons at all. */
export const isViewer = (who: Me | null, repo: string): boolean => !!who?.auth && !can(who, "create", repo);

/** UI-213, UI-220: a viewer has no new intent button; a person who may create on any repo has. */
export function canCreateAnywhere(who: Me | null): boolean {
  if (!who?.auth) return true;
  return can(who, "create") || Object.keys(who.repoRoles).some((r) => can(who, "create", r));
}
