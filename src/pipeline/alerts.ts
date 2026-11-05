// Code scanning alerts for a repair round (PIP-148..150): a failed check with no Actions run log
// (`CodeQL`) is explained by the open alerts of the PR's merge ref, in the files the PR changes.

import type { Db } from "../db.ts";
import { type Check, type CodeScanningAlert, ForgeDenied } from "../forge.ts";
import type { Ctx } from "../handlers.ts";

const KEY = "code-scanning-permission";
export const MAX_ALERTS = 20;

/** PIP-150: the owner's one step for it; ticking clears the flag. */
export const SCANNING_STEP = "Grant the Towercab GitHub App the Code scanning alerts: read permission";

const NEEDS_PERMISSION =
  "(the code scanning alerts couldn't be read: the GitHub App needs the Code scanning alerts: read permission)";

export function scanningPermissionMissing(db: Db): boolean {
  return db.meta(KEY) !== null;
}

export function setScanningPermission(db: Db, repo: string, at: number): void {
  if (!db.meta(KEY)) db.setMeta(KEY, JSON.stringify({ at, repo }));
}

/** The owner ticked the step: the next red check reads again. */
export function grantScanning(db: Db): boolean {
  const had = db.meta(KEY) !== null;
  db.delMeta(KEY);
  return had;
}

/** The alerts in `files`, one line each (`MAX_ALERTS` at most, then `and <k> more`); "" when none. */
export function alertLines(alerts: CodeScanningAlert[], files: Set<string>): string {
  const kept = alerts.filter((a) => files.has(a.path));
  if (!kept.length) return "";
  const lines = kept.slice(0, MAX_ALERTS).map((a) => {
    const where = a.line === null ? a.path : `${a.path}:${a.line}`;
    return `- ${a.rule} at ${where}: ${a.message.replace(/\s+/g, " ").trim()}`;
  });
  if (kept.length > MAX_ALERTS) lines.push(`and ${kept.length - MAX_ALERTS} more`);
  return `Code scanning alerts:\n${lines.join("\n")}`;
}

/**
 * The alert block for the repair details, or "" when every red check has an Actions run or there is
 * nothing to say. A read that fails never throws (PIP-149); a refusal sets the owner's step (PIP-150).
 */
export async function alertsBlock(cx: Ctx, github: string, pr: number, checks: Check[]): Promise<string> {
  if (!checks.some((c) => c.run === null)) return "";
  if (scanningPermissionMissing(cx.db)) return NEEDS_PERMISSION;
  try {
    const alerts = await cx.github.codeScanningAlerts(github, pr);
    if (!alerts.length) return "";
    const files = new Set((await cx.github.prFiles(github, pr)).map((f) => f.filename));
    return alertLines(alerts, files);
  } catch (e) {
    if (e instanceof ForgeDenied) {
      setScanningPermission(cx.db, github, cx.clock.now());
      return NEEDS_PERMISSION;
    }
    return `(the code scanning alerts couldn't be read: ${(e as Error).message})`;
  }
}
