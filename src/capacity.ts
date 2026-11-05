// How much runs at once (LOOP-103, LOOP-104): the default limit from the machine, and what `status`, the
// overview and `doctor` say about slots.

import { availableParallelism, freemem } from "node:os";
import type { Db } from "./db.ts";
import { dataOf, type Mission, unfinished } from "./mission.ts";

export interface Capacity {
  cores: number;
  freeBytes: number;
}

/** The oldest slot wait that `doctor` calls long (LOOP-104). */
export const SLOT_WAIT_HINT_S = 30 * 60;

const GIB = 2 ** 30;

export function readCapacity(): Capacity {
  return { cores: availableParallelism(), freeBytes: freemem() };
}

/** LOOP-103: `max(1, min(4, floor(cores / 3), floor(free GB / 1.5)))`. */
export function defaultParallel(c: Capacity): number {
  return Math.max(1, Math.min(4, Math.floor(c.cores / 3), Math.floor(c.freeBytes / GIB / 1.5)));
}

/** The key `missions.data` keeps while a run waits for a free slot, and the step it was set at. */
export const SLOT_WAIT_KEYS = ["slot_wait_since", "slot_wait_step"] as const;

export function slotStep(m: Mission): string {
  return `${m.stage}/${m.step}`;
}

/** Runs going now: missions with a child process. */
export function runsGoing(db: Db): number {
  return unfinished(db).filter((m) => m.child_pid !== null).length;
}

export interface SlotWait {
  intent: string;
  since: number;
  secs: number;
}

/** LOOP-104: the mission that has waited longest only for a free slot; a stamp that no longer holds is ignored. */
export function oldestSlotWait(db: Db, now: number): SlotWait | null {
  let best: SlotWait | null = null;
  for (const m of unfinished(db)) {
    if (m.child_pid !== null) continue;
    const d = dataOf<{ slot_wait_since?: unknown; slot_wait_step?: unknown }>(m);
    if (typeof d.slot_wait_since !== "number" || d.slot_wait_step !== slotStep(m)) continue;
    if (best === null || d.slot_wait_since < best.since) {
      best = { intent: m.intent, since: d.slot_wait_since, secs: Math.max(0, now - d.slot_wait_since) };
    }
  }
  return best;
}

export function durationText(secs: number): string {
  const min = Math.floor(secs / 60);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
}

/** `status` lines (LOOP-104). */
export function slotLines(db: Db, now: number, limit: number): string[] {
  const lines = [`running: ${runsGoing(db)} of ${limit} runs`];
  const w = oldestSlotWait(db, now);
  if (w) lines.push(`oldest wait for a free slot: ${w.intent} ${durationText(w.secs)}`);
  return lines;
}

/** The overview's sentence: runs going against the limit, and the longest wait for a slot when there is one. */
export function slotsText(db: Db, now: number, limit: number): string {
  const n = runsGoing(db);
  const w = oldestSlotWait(db, now);
  const going = `${n} of ${limit} runs going`;
  return w ? `${going} · the longest wait for a free slot is ${durationText(w.secs)}` : going;
}

/** The `doctor` line of LOOP-104, or null. */
export function slotHint(o: { db: Db; now: number; limit: number; capacity: Capacity }): string | null {
  const w = oldestSlotWait(o.db, o.now);
  if (!w || w.secs <= SLOT_WAIT_HINT_S) return null;
  const room = defaultParallel(o.capacity);
  if (room <= o.limit) return null;
  return `slots: ${w.intent} waited ${durationText(w.secs)} for a free run; the machine has room for ${room}, raise [agent].parallel from ${o.limit}`;
}
