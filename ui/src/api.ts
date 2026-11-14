// Talking to the loop (UI-65, UI-67): JSON reads, actions with the page's token, and a live version
// from /api/events (polling every 5 s while the stream is down).

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ActionReply } from "../../src/ui/view.ts";

const token = document.querySelector('meta[name="towercab-token"]')?.getAttribute("content") ?? "";

export async function getJson<T>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error("Can't reach Towercab. Is it still running?");
  }
  const body = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok) throw new Error(body?.error ?? `Towercab answered ${r.status}.`);
  return body as T;
}

export function act(action: string, intent?: string, text?: string): Promise<ActionReply> {
  return post({ action, intent, text });
}

/** UI-253: save a scope's budget (`all`) or a repo's caps; an amount left out stays, null removes it. */
export function saveBudgets(
  scope: string,
  daily?: number | null,
  monthly?: number | null,
): Promise<ActionReply> {
  return post({ action: "budgets", scope, daily, monthly });
}

/** UI-160, SHIP-22: tick (or untick) one of the owner's steps. */
export function tickStep(intent: string, n: number, done: boolean): Promise<ActionReply> {
  return post({ action: "step", intent, n, done });
}

/** SHIP-35: write the value typed for a supplied secret. */
export function sendSecret(intent: string, n: number, value: string): Promise<ActionReply> {
  return post({ action: "secret", intent, n, value });
}

/** SHIP-34: approve a secret's pull request (or try again after a failure). */
export function approveSecret(intent: string, n: number): Promise<ActionReply> {
  return post({ action: "approve-secret", intent, n });
}

/** UI-130, UI-131: add `owner/name` as a repo, under `name` when given. */
export function addRepo(github: string, name?: string): Promise<ActionReply> {
  return post({ action: "addRepo", github, name });
}

/** What the new intent form sends (UI-216). */
export interface IntentDraft {
  repo: string;
  title: string;
  u?: number;
  i?: number;
  a?: number;
  problem?: string;
  outcome?: string;
  affected?: string;
  constraints?: string;
  questions?: string;
}

/** UI-214: the overlap check; the reply lists the matches. */
export function checkIntent(draft: IntentDraft): Promise<ActionReply> {
  return post({ action: "checkIntent", ...draft });
}

/** UI-216: write the intent, or add its text to `addTo`. */
export function createIntent(draft: IntentDraft, addTo?: string): Promise<ActionReply> {
  return post({ action: "createIntent", ...draft, ...(addTo ? { addTo } : {}) });
}

/** UI-185: merge a proposed intent's PR, as the card showed it at `head`. */
export function acceptProposed(pr: number, head: string): Promise<ActionReply> {
  return post({ action: "accept", pr, head });
}

/** UI-185: close a proposed intent's PR with a reason (empty: the default). */
export function closeProposed(pr: number, text: string): Promise<ActionReply> {
  return post({ action: "close", pr, text: text.trim() || undefined });
}

/** REPO-39: apply the standard settings of one repo with the owner's own login. */
export function applySettings(repo: string): Promise<ActionReply> {
  return post({ action: "apply-settings", repo });
}

/** UI-151: open (or update) the PR that changes a repo's limits; `null` takes a key out of the file. */
export function saveLimits(
  repo: string,
  changes: Record<string, number | null>,
  confirmed: boolean,
): Promise<ActionReply> {
  return post({ action: "repo-settings", repo, changes, confirmed });
}

/** UI-154: open the PR that moves a repo's limits into its file again. */
export function openMove(repo: string): Promise<ActionReply> {
  return post({ action: "repo-move", repo });
}

/** UI-257: set an intent's autonomy (0–5); the page is the owner (AUT-35). */
export function setAutonomy(id: string, a: number): Promise<ActionReply> {
  return post({ action: "autonomy", id, a, actor: "owner" });
}

/** UI-204: change urgency and/or importance (1-5); the reply carries the new priority. */
export function setScores(id: string, change: { u?: number; i?: number }): Promise<ActionReply> {
  return post({ action: "scores", id, ...change, actor: "owner" });
}

/** UI-205: a5, and the start of an intent that has not started. */
export function boostIntent(id: string): Promise<ActionReply> {
  return post({ action: "boost", id, actor: "owner" });
}

/** UI-144: read the repo again for its feature list. */
export function refreshFeatures(repo: string): Promise<ActionReply> {
  return post({ action: "features", repo });
}

async function post(req: Record<string, unknown>): Promise<ActionReply> {
  try {
    const r = await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Towercab-Token": token },
      body: JSON.stringify(req),
    });
    const body = (await r.json().catch(() => null)) as ActionReply | null;
    return body ?? { ok: false, message: `Towercab answered ${r.status}.` };
  } catch {
    return { ok: false, message: "Can't reach Towercab. Is it still running?" };
  } finally {
    bump();
  }
}

// The live version: every subscriber reloads when it changes.
const subs = new Set<() => void>();
let version = "";
let poll: number | null = null;
let source: EventSource | null = null;

function bump() {
  for (const s of subs) s();
}

function connect() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  source.addEventListener("version", (e) => {
    const v = (e as MessageEvent<string>).data;
    if (v !== version) {
      const first = version === "";
      version = v;
      if (!first) bump();
    }
  });
  source.onopen = () => {
    if (poll !== null) {
      clearInterval(poll);
      poll = null;
    }
  };
  source.onerror = () => {
    if (poll === null) poll = window.setInterval(bump, 5000);
  };
}

/** Freshness for "Updated n s ago": the time of the last successful read. */
let lastRead = 0;
const freshSubs = new Set<(t: number) => void>();

export function useFreshness(): number {
  const [t, setT] = useState(lastRead);
  useEffect(() => {
    freshSubs.add(setT);
    return () => freshSubs.delete(setT);
  }, []);
  return t;
}

export interface Live<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Read `path` now and again whenever Towercab's version changes. Keeps the last data while reloading. */
export function useLive<T>(path: string): Live<T> {
  const [state, setState] = useState<Live<T>>({ data: null, error: null, loading: true });
  const current = useRef(path);
  current.current = path;
  const load = useCallback(() => {
    const p = path;
    getJson<T>(p).then(
      (data) => {
        if (current.current !== p) return;
        lastRead = Date.now();
        for (const f of freshSubs) f(lastRead);
        setState({ data, error: null, loading: false });
      },
      (e: Error) => {
        if (current.current !== p) return;
        setState((s) => ({ data: s.data, error: e.message, loading: false }));
      },
    );
  }, [path]);
  useEffect(() => {
    connect();
    setState((s) => ({ ...s, loading: true }));
    load();
    subs.add(load);
    return () => {
      subs.delete(load);
    };
  }, [load]);
  return state;
}

/** UI-264: the owner looked at the Inbox; the server stamps its own clock. */
export function markSeen(): Promise<ActionReply> {
  return post({ action: "seen" });
}

/** UI-264: put an item aside until `until` (unix seconds). */
export function snoozeItem(item: string, until: number): Promise<ActionReply> {
  return post({ action: "snooze", item, until });
}

export function unsnoozeItem(item: string): Promise<ActionReply> {
  return post({ action: "unsnooze", item });
}
