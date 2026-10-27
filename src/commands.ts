// Commands (LOOP-15): answer, retry, drop, pause, resume. The CLI and the UI insert a `commands` row;
// the loop applies it on its next pass, or the CLI applies it itself when no loop runs.

import type { Db } from "./db.ts";
import type { IntentStore } from "./intents/types.ts";
import { type ApplyCtx, apply } from "./machine.ts";
import { type Mission, unfinishedFor } from "./mission.ts";

export type CommandName = "answer" | "retry" | "drop" | "pause" | "resume";

export interface CommandRow {
  id: number;
  name: CommandName;
  arg: string;
  text: string;
  source: string;
  created: number;
  applied_at: number | null;
  result: string | null;
}

export const MAX_ANSWER = 2000;

export function insertCommand(
  db: Db,
  c: { name: CommandName; arg?: string; text?: string; source: string },
  now: number,
): number {
  if (c.name === "answer" && (!c.text?.trim() || c.text.length > MAX_ANSWER)) {
    throw new Error(`an answer is 1 to ${MAX_ANSWER} characters`);
  }
  return db.run(
    "INSERT INTO commands (name, arg, text, source, created) VALUES (?, ?, ?, ?, ?)",
    c.name,
    c.arg ?? "",
    c.text ?? "",
    c.source,
    now,
  ).lastId;
}

export function pendingCommands(db: Db): CommandRow[] {
  return db.all<CommandRow>("SELECT * FROM commands WHERE applied_at IS NULL ORDER BY id");
}

export function commandResult(db: Db, id: number): string | null {
  return db.get<{ result: string | null }>("SELECT result FROM commands WHERE id = ?", id)?.result ?? null;
}

export interface CommandCtx {
  db: Db;
  store: IntentStore;
  applyCtx: ApplyCtx;
  now: Date;
}

export function paused(db: Db): boolean {
  return db.meta("paused") === "1";
}

/** Apply one command; its reply (or error text) is stored with it. */
export async function applyCommand(cx: CommandCtx, row: CommandRow): Promise<string> {
  let result: string;
  try {
    result = await run(cx, row);
  } catch (e) {
    result = `${row.name}: ${(e as Error).message}`;
  }
  cx.db.run(
    "UPDATE commands SET applied_at = ?, result = ? WHERE id = ?",
    cx.now.getTime() / 1000,
    result,
    row.id,
  );
  return result;
}

export async function applyPending(cx: CommandCtx): Promise<{ id: number; result: string }[]> {
  const out: { id: number; result: string }[] = [];
  for (const row of pendingCommands(cx.db)) out.push({ id: row.id, result: await applyCommand(cx, row) });
  return out;
}

async function run(cx: CommandCtx, row: CommandRow): Promise<string> {
  const { db, store } = cx;
  switch (row.name) {
    case "pause":
      db.setMeta("paused", "1");
      return "paused: nothing new starts, and merges wait until you resume";
    case "resume": {
      db.delMeta("paused");
      const held = db.all<Mission>(
        "SELECT * FROM missions WHERE held = 1 AND stage NOT IN ('done','stopped')",
      );
      for (const m of held) {
        db.run("UPDATE missions SET held = 0 WHERE id = ?", m.id);
        apply(cx.applyCtx, { ...m, held: 0 }, { event: "resume" });
      }
      return "resumed";
    }
    case "answer": {
      const intent = await store.get(row.arg);
      const m = unfinishedFor(db, intent.id);
      if (!m && !intent.waiting) throw new Error(`${intent.id} isn't waiting on you`);
      await store.update(intent.id, "answer", (e) => {
        e.addAnswer(row.text, cx.now);
        if (!m) e.removeField("waiting");
      });
      if (m?.stage === "blocked") {
        apply(cx.applyCtx, m, { event: "answered", text: row.text });
        return `answered ${intent.id}; it continues`;
      }
      return m ? `noted for ${intent.id}: the worker gets it with its next run` : `answered ${intent.id}`;
    }
    case "retry": {
      const intent = await store.get(row.arg);
      const m = unfinishedFor(db, intent.id);
      if (m) {
        const fresh = apply(cx.applyCtx, m, { event: "retry_fresh" });
        return `fresh attempt ${fresh.attempt} for ${intent.id}`;
      }
      await store.update(intent.id, "retry", (e) => {
        e.removeField("stage");
        e.removeField("waiting");
        e.removeField("retry");
      });
      return `${intent.id} is queued for a fresh attempt`;
    }
    case "drop": {
      const intent = await store.get(row.arg);
      const m = unfinishedFor(db, intent.id);
      if (m) apply(cx.applyCtx, m, { event: "intent_removed", why: "dropped" });
      await store.update(intent.id, "drop", (e) => {
        e.setField("stage", "dropped");
        e.removeField("waiting");
      });
      return `dropped ${intent.id}`;
    }
  }
}
