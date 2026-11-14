// Who the page is signed in as (UI-219, UI-220): `/api/me`, and the role rules the buttons follow.

import { useEffect, useState } from "preact/hooks";

const ROLES = ["viewer", "contributor", "maintainer", "admin"];

export interface Me {
  auth: boolean;
  login: string;
  name: string;
  role: string;
  repos: Record<string, string>;
  telegram: boolean;
  /** Each action → the lowest role that may do it. */
  needs: Record<string, string>;
}

export type MeState = { state: "loading" } | { state: "out"; was: boolean } | { state: "in"; me: Me };

let current: MeState = { state: "loading" };
let had = false;
const subs = new Set<(s: MeState) => void>();

function set(s: MeState) {
  current = s;
  for (const f of subs) f(s);
}

/** Read `/api/me`; a 401 is the sign-in screen (and "You were signed out" when a session had been seen). */
export async function loadMe(): Promise<void> {
  try {
    const r = await fetch("/api/me", { headers: { Accept: "application/json" } });
    if (r.status === 401) return set({ state: "out", was: had });
    if (!r.ok) return;
    had = true;
    set({ state: "in", me: (await r.json()) as Me });
  } catch {
    // Towercab is unreachable: keep what the page knows.
  }
}

/** Any API answer of 401 means the session ended (UI-219). */
export function signedOut(): void {
  set({ state: "out", was: had });
}

export function useMe(): MeState {
  const [s, setS] = useState(current);
  useEffect(() => {
    subs.add(setS);
    if (current.state === "loading") void loadMe();
    return () => {
      subs.delete(setS);
    };
  }, []);
  return s;
}

const rank = (r: string) => ROLES.indexOf(r);

/** The person's role on `repo`: the repo's own role, else the default (admin is global). */
export function roleOn(me: Me, repo?: string): string {
  if (me.role === "admin") return "admin";
  return (repo && me.repos[repo]) || me.role;
}

export interface Gate {
  /** Show the control at all (a viewer sees none). */
  show: boolean;
  allowed: boolean;
  /** UI-220: why a shown control is disabled. */
  why: string;
}

/** Whether `me` may do `action` on `repo` (the server checks again, USR-7). */
export function gate(me: Me | null, action: string, repo?: string): Gate {
  if (!me || !me.auth) return { show: true, allowed: true, why: "" };
  const have = roleOn(me, repo);
  const need = me.needs[action] ?? "admin";
  if (rank(have) >= rank(need)) return { show: true, allowed: true, why: "" };
  return {
    show: have !== "viewer",
    allowed: false,
    why: `Needs ${need}${repo ? ` on ${repo}` : ""} (you are ${have})`,
  };
}

let meNow: Me | null = null;
subs.add((s) => {
  meNow = s.state === "in" ? s.me : null;
});

/** For components that cannot hold the state themselves. */
export const currentMe = (): Me | null => meNow;
