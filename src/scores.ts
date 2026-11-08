// Changing an intent's urgency and importance (LOOP-133, LOOP-135) and boosting it to a5 (LOOP-134).
// The intent file stays the one source: every change is one commit that touches only the lines it names.

import { ownSource } from "./autonomy.ts";
import {
  acceptedOf,
  clearFlag,
  flagOf,
  recordChange,
  setAccepted,
  setFlag,
  writtenLevel,
} from "./autonomy-change.ts";
import type { Db } from "./db.ts";
import type { Intent, IntentStore } from "./intents/types.ts";
import { DEFAULT_SCORE, isParked, priority } from "./priority.ts";

export interface ScoreChange {
  u?: number;
  i?: number;
}

/** LOOP-135: `u=4 i=2` words, each key at most once, values 1–5. */
export function parseScoreWords(words: string[]): ScoreChange {
  const out: ScoreChange = {};
  for (const w of words) {
    const m = /^([ui])=([1-5])$/.exec(w);
    const key = m?.[1] as keyof ScoreChange | undefined;
    if (!m || !key || out[key] !== undefined) {
      throw new Error(`bad score ${JSON.stringify(w)}: want u=N or i=N with N 1-5, each once`);
    }
    out[key] = Number(m[2]);
  }
  if (out.u === undefined && out.i === undefined) throw new Error("want u=N and/or i=N with N 1-5");
  return out;
}

/** LOOP-133: a score change shown on the timeline and the Activity page. */
export interface ScoreRecord {
  intent: string;
  at: number;
  by: string;
  /** `[from, to]` for each score that changed. */
  u?: [number, number];
  i?: [number, number];
}

export function recordScores(db: Db, r: ScoreRecord): void {
  db.setMeta(`score-change:${r.intent}:${r.at}`, JSON.stringify(r));
}

export function scoreChanges(db: Db, intent?: string): ScoreRecord[] {
  return db
    .all<{ value: string }>(
      "SELECT value FROM meta WHERE key LIKE ? ESCAPE '\\'",
      intent ? `score-change:${intent}:%` : "score-change:%",
    )
    .map((r) => JSON.parse(r.value) as ScoreRecord)
    .sort((a, b) => a.at - b.at);
}

export function scoreWords(r: ScoreRecord): string {
  return [r.u ? `u: ${r.u[0]} → ${r.u[1]}` : "", r.i ? `i: ${r.i[0]} → ${r.i[1]}` : ""]
    .filter(Boolean)
    .join(", ");
}

export interface ScoreResult {
  /** One sentence for the owner. */
  message: string;
  priority: number;
  parked: boolean;
  changed: boolean;
}

function open(found: Intent): Intent {
  if (found.done) throw new Error(`${found.id} is done or dropped`);
  return found;
}

/**
 * LOOP-133: set `u` and/or `i` (1–5) in the intent file, in one commit; the same values write nothing.
 * A running mission is not touched: priority only decides picks and order that have not happened yet.
 */
export async function changeScores(
  cx: { db: Db; store: IntentStore; now: number; cutoff: number },
  id: string,
  change: ScoreChange,
  by: string,
): Promise<ScoreResult> {
  for (const k of ["u", "i"] as const) {
    const v = change[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 5)) {
      throw new Error(`${k === "u" ? "Urgency" : "Importance"} is 1 to 5.`);
    }
  }
  if (change.u === undefined && change.i === undefined) {
    throw new Error("Which score? Urgency or importance.");
  }
  const found = open(await cx.store.get(id));
  const now = (n: number | null) => n ?? DEFAULT_SCORE;
  const rec: ScoreRecord = { intent: found.id, at: cx.now, by };
  // A missing score counts as 3 and is written only when it differs from 3 (PRI-2).
  const writes: [keyof ScoreChange, number][] = [];
  for (const k of ["u", "i"] as const) {
    const to = change[k];
    if (to !== undefined && to !== now(found[k])) {
      writes.push([k, to]);
      rec[k] = [now(found[k]), to];
    }
  }
  const p = priority(change.u ?? found.u, change.i ?? found.i);
  const result = { priority: p, parked: isParked(p, cx.cutoff) };
  if (writes.length === 0) {
    const same = `u ${now(found.u)}, i ${now(found.i)}`;
    return { ...result, changed: false, message: `${found.id} already has ${same}` };
  }
  await cx.store.update(found.id, "set scores", (e) => {
    for (const [k, v] of writes) e.setField(k, v);
  });
  recordScores(cx.db, rec);
  return {
    ...result,
    changed: true,
    message: `${found.id}: ${scoreWords(rec)}; priority ${p}${result.parked ? ", parked: raise u or i to run it" : ""}`,
  };
}

/** UI-205: whether Boost is for this intent (AUT-13): the owner's own, not finished. */
export function canBoostIntent(i: Pick<Intent, "source" | "done">): boolean {
  return ownSource(i.source) && !i.done;
}

/**
 * LOOP-134 step 1: `a: 5`, and the worker's lowering note gone, in one commit. The accepted level moves
 * first, as the page's own autonomy change does (AUT-35), so the loop never flags Towercab's own commit.
 */
export async function raiseToFull(
  cx: { db: Db; store: IntentStore; now: number },
  id: string,
): Promise<{ found: Intent; from: number }> {
  const found = open(await cx.store.get(id));
  if (!ownSource(found.source)) throw new Error("a5 is only for the owner's own intents");
  const flag = flagOf(cx.db, found.id);
  const from = flag ? flag.from : writtenLevel(found);
  const was = acceptedOf(cx.db, found.id);
  setAccepted(cx.db, found.id, 5);
  clearFlag(cx.db, found.id);
  try {
    await cx.store.update(found.id, "boost", (e) => {
      if (found.a !== null && found.a !== 5) e.setField("a", 5);
      // The owner raised it on purpose: the worker's note about the lower level no longer applies.
      e.removeField("lower_why");
    });
  } catch (e) {
    if (was !== null) setAccepted(cx.db, found.id, was);
    if (flag) setFlag(cx.db, found.id, flag);
    throw e;
  }
  if (from !== 5) recordChange(cx.db, { intent: found.id, from, to: 5, at: cx.now });
  return { found, from };
}
