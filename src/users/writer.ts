// AUT-23: who wrote an intent, and what that allows. The writer comes from the channel the intent came by
// (the verified account that pushed the file, the linked Telegram person, the signed-in person, the
// owner for the command line and for work from before sign-in), never from the file's own lines. It is kept
// in `meta`, so no intent file is rewritten and a later edit never changes it.

import type { Db } from "../db.ts";
import type { CommitProof } from "../forge.ts";
import { can, type Role, roleFor, type User } from "../users.ts";
import { getUser } from "./store.ts";

export type WriterVia = "github" | "telegram" | "page" | "cli" | "before-auth";

/** The writer: a login, or null when the channel can't say (an unverified push). */
export interface Writer {
  login: string | null;
  via: WriterVia;
}

export interface Confirmation {
  login: string;
  via: string;
  at: number;
}

const WEB_COMMITTER = "web-flow";
const writerKey = (id: string) => `writer:${id}`;
const confirmKey = (id: string) => `confirmed:${id}`;
/** Set once the intents that existed when `[auth]` was first switched on were credited to the owner. */
export const SEEDED_KEY = "writers:seeded";

export function writerOf(db: Db, intent: string): Writer | null {
  const v = db.meta(writerKey(intent));
  return v === null ? null : (JSON.parse(v) as Writer);
}

/** Record the writer once; a second record (a later edit by someone else) changes nothing. */
export function recordWriter(db: Db, intent: string, w: Writer): boolean {
  if (db.meta(writerKey(intent)) !== null) return false;
  db.setMeta(writerKey(intent), JSON.stringify(w));
  return true;
}

export function confirmationOf(db: Db, intent: string): Confirmation | null {
  const v = db.meta(confirmKey(intent));
  return v === null ? null : (JSON.parse(v) as Confirmation);
}

/**
 * AUT-23: the account that pushed the commit adding the file, judged as AUT-35 judges a raise: GitHub
 * must have verified the signature, and the account is the committer, or the author of a commit made on
 * the host's web page. Anything else has no writer.
 */
export function writerFromProof(proof: CommitProof | null): Writer {
  if (!proof?.verified) return { login: null, via: "github" };
  const account = proof.committer === WEB_COMMITTER ? proof.author : proof.committer;
  return { login: account ? account.toLowerCase() : null, via: "github" };
}

/** What the writer's role allows (AUT-23): the highest `a` and whether the intent waits for a confirmation. */
export function startPolicy(role: Role | null): { ceiling: number; hold: boolean } {
  if (role === "admin" || role === "maintainer") return { ceiling: 5, hold: false };
  if (role === "contributor") return { ceiling: 4, hold: false };
  return { ceiling: 4, hold: true };
}

/**
 * AUT-23: how an intent starts. `writer` and `confirmer` are the people now (null: unknown or disabled);
 * a valid confirmation by a maintainer lifts it as if a maintainer had written it. The roles are read
 * at the time of the gate.
 */
export function policyFor(
  writer: User | null,
  confirmer: User | null,
  repos: string[],
): { ceiling: number; hold: boolean } {
  const lowest = (u: User | null): Role | null => {
    if (!u || u.disabled) return null;
    const roles = repos.map((r) => roleFor(u, r));
    return roles.reduce((a, b) => (rank(a) <= rank(b) ? a : b));
  };
  const confirms = confirmer && !confirmer.disabled && repos.every((r) => can(confirmer, "confirm", r));
  if (confirms) return { ceiling: 5, hold: false };
  return startPolicy(lowest(writer));
}

const rank = (r: Role) => ["viewer", "contributor", "maintainer", "admin"].indexOf(r);

/** AUT-23: a maintainer (or admin) of every repo of the intent confirms it. Refused for anyone else. */
export function confirmIntent(
  db: Db,
  by: User,
  intent: string,
  repos: string[],
  via: string,
  now: number,
): Confirmation {
  const why = repos.find((r) => !can(by, "confirm", r));
  if (why !== undefined) throw new Error(`your role (${roleFor(by, why)}) can't confirm on ${why}`);
  const c: Confirmation = { login: by.login, via, at: now };
  db.setMeta(confirmKey(intent), JSON.stringify(c));
  return c;
}

/**
 * The ceiling from the people's rows now (no team lookup): what the page checks before it lets someone
 * set a5. The gate uses the loop's own answer, which includes the team.
 */
export function ceilingNow(db: Db, intent: string, repos: string[]): number {
  const w = writerOf(db, intent);
  const c = confirmationOf(db, intent);
  const writer = w?.login ? getUser(db, w.login) : null;
  const confirmer = c ? getUser(db, c.login) : null;
  return policyFor(writer, confirmer, repos).ceiling;
}
