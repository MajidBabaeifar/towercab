// The page's sign-in guard (USR-4, USR-7): which permission each action needs, and the session cookie.

import type { IncomingMessage } from "node:http";
import type { UserAction } from "../users.ts";

export const COOKIE = "tc_session";

/**
 * USR-7: every action of `POST /api/actions` with the permission it needs. A name missing here is refused
 * by `permissionOf`, and `users: a viewer gets 403 on every action route` walks the whole table.
 */
export const ACTION_PERMISSION: Record<string, UserAction> = {
  checkIntent: "create",
  createIntent: "create",
  autonomy: "raise",
  "set-fast": "edit",
  "set-kind": "edit",
  scores: "edit",
  boost: "boost",
  merge: "merge",
  confirm: "confirm",
  pass: "drop",
  reply: "reply",
  retry: "retry",
  drop: "drop",
  start: "start",
  step: "edit",
  secret: "edit",
  "approve-secret": "approve",
  done: "edit",
  steps: "edit",
  pause: "pause",
  resume: "resume",
  unfreeze: "resume",
  "apply-settings": "settings",
  scanningGranted: "settings",
  addRepo: "settings",
  features: "settings",
  accept: "approve",
  close: "drop",
  shadowReset: "settings",
  "repo-settings": "settings",
  "repo-move": "settings",
  budgets: "settings",
  seen: "answer",
  snooze: "answer",
  unsnooze: "answer",
};

export const permissionOf = (action: string): UserAction | null => ACTION_PERMISSION[action] ?? null;

/** The value of cookie `name`, or "". */
export function cookieOf(req: IncomingMessage, name = COOKIE): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return "";
}

/** USR-4: `HttpOnly; Secure; SameSite=Lax`; a null token clears it. */
export function sessionCookie(token: string | null, maxAgeSecs: number): string {
  const base = `${COOKIE}=${token ?? ""}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  return token === null ? `${base}; Max-Age=0` : `${base}; Max-Age=${maxAgeSecs}`;
}
