// GL-17: the owner is told once when the GitLab token is within 14 days of expiring.

import type { Db } from "../db.ts";
import { TOKEN_WARN_DAYS } from "../doctor.ts";
import type { GitLabForge } from "./gitlab.ts";

const DAY_S = 86_400;

/**
 * Reads the token's expiry; within `TOKEN_WARN_DAYS` days it queues one message (LOOP-14) keyed by the expiry date,
 * so a restart does not repeat it and a new token with a new date can notify again. No expiry, an expired
 * token (an auth failure, GL-2) and a failed read send nothing. Returns whether a message was queued.
 */
export async function queueTokenNotice(gl: GitLabForge, db: Db, now: number): Promise<boolean> {
  let expiresAt: string | null;
  let active: boolean;
  try {
    const t = await gl.tokenInfo();
    expiresAt = t.expiresAt;
    active = t.active;
  } catch {
    return false;
  }
  if (!expiresAt || !active) return false;
  const exp = Date.parse(`${expiresAt}T23:59:59Z`) / 1000;
  if (Number.isNaN(exp) || exp < now || exp - now >= TOKEN_WARN_DAYS * DAY_S) return false;
  const days = Math.max(0, Math.floor((exp - now) / DAY_S));
  const r = db.run(
    "INSERT OR IGNORE INTO outbox (key, mission, text, created) VALUES (?, NULL, ?, ?)",
    `gitlab-token:${expiresAt}`,
    `GitLab token expires in ${days} days (${expiresAt}): create a new one before then`,
    now,
  );
  return r.changes > 0;
}
