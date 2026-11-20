// CHAT-1..12: one intent as a chat. The thread is the workers' own Claude transcripts, Towercab's moves
// between them, and the owner's messages; a message is queued and goes in through the reply the
// pipeline already reads, so it never races a run.

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db.ts";
import { WAIT_STAGES } from "../machine.ts";
import type { Mission } from "../mission.ts";
import type { ChatItem, ChatMessage, ChatPage, ChatTool } from "./view.ts";

/** CHAT-6: how many items a page of the thread holds. */
export const PAGE = 200;
/** CHAT-9: the longest message the composer sends. */
export const MAX_CHAT = 4000;
/** CHAT-5: a tool's input or result shown folded is cut to this. */
const TOOL_TEXT = 2000;

/** One run whose result names its Claude session. */
interface RunRef {
  stage: string;
  kind: string;
  n: number;
  session: string;
  at: number;
  file: string;
}

/** The runs of an intent, oldest first: `runs/<id>/<stage>/<kind>-<n>.json` that name a `session_id`. */
export function runsOf(runsRoot: string, intent: string): RunRef[] {
  const dir = join(runsRoot, intent);
  if (!existsSync(dir)) return [];
  const out: RunRef[] = [];
  const visit = (d: string, stage: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!stage) visit(p, f);
        continue;
      }
      const m = /^([a-z]+)-(\d+)\.json$/.exec(f);
      if (!m) continue;
      let session = "";
      try {
        session = String((JSON.parse(readFileSync(p, "utf8")) as { session_id?: string }).session_id ?? "");
      } catch {
        continue;
      }
      if (session)
        out.push({
          stage: stage || m[1]!,
          kind: m[1]!,
          n: Number(m[2]),
          session,
          at: st.mtimeMs / 1000,
          file: p,
        });
    }
  };
  visit(dir, "");
  return out.sort((a, b) => a.at - b.at);
}

/**
 * CHAT-4: the transcript of a session. Towercab's own copy next to the run is preferred; otherwise the
 * file Claude Code keeps under `~/.claude/projects/<workspace>/<session>.jsonl` (any workspace folder).
 */
export function transcriptPath(run: RunRef, claudeHome = join(homedir(), ".claude")): string | null {
  const copy = run.file.replace(/\.json$/, ".transcript.jsonl");
  if (existsSync(copy)) return copy;
  const projects = join(claudeHome, "projects");
  if (!existsSync(projects)) return null;
  for (const d of readdirSync(projects)) {
    const p = join(projects, d, `${run.session}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** CHAT-4: keep a copy of a finished run's transcript, so Claude Code's 30-day cleanup can't lose it. */
export function keepTranscript(resultFile: string, claudeHome = join(homedir(), ".claude")): void {
  try {
    const session = String(
      (JSON.parse(readFileSync(resultFile, "utf8")) as { session_id?: string }).session_id ?? "",
    );
    if (!session) return;
    const from = transcriptPath({ stage: "", kind: "", n: 0, session, at: 0, file: "\0" }, claudeHome);
    if (from) copyFileSync(from, resultFile.replace(/\.json$/, ".transcript.jsonl"));
  } catch {
    // A missing transcript only means the thread shows the run's result alone (CHAT-7).
  }
}

const cut = (s: string, n = TOOL_TEXT) => (s.length > n ? `${s.slice(0, n)}…` : s);

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((x) =>
        typeof x === "string" ? x : x && typeof x === "object" && "text" in x ? String(x.text) : "",
      )
      .join("\n");
  return "";
}

/** CHAT-5: one transcript as messages: the prompt, each answer's text, and its tool calls folded. */
export function parseTranscript(text: string, run: RunRef): ChatMessage[] {
  const out: ChatMessage[] = [];
  const tools = new Map<string, ChatTool>();
  let first = true;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; timestamp?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.type !== "user" && e.type !== "assistant") || e.isMeta || !e.message) continue;
    const at = e.timestamp ? Date.parse(e.timestamp) / 1000 : run.at;
    const content = e.message.content;
    if (e.type === "user") {
      const parts = Array.isArray(content) ? content : [content];
      for (const p of parts) {
        if (p && typeof p === "object" && (p as { type?: string }).type === "tool_result") {
          const r = p as { tool_use_id?: string; content?: unknown; is_error?: boolean };
          const t = tools.get(String(r.tool_use_id));
          if (t) {
            t.result = cut(textOf(r.content));
            t.error = Boolean(r.is_error);
          }
        }
      }
      const said = textOf(
        Array.isArray(content) ? content.filter((p) => p?.type === "text") : content,
      ).trim();
      if (said) {
        out.push({
          type: "message",
          key: `${run.session}:${out.length}`,
          role: first ? "prompt" : "user",
          at,
          text: said,
          tools: [],
        });
        first = false;
      }
      continue;
    }
    const parts = Array.isArray(content) ? content : [{ type: "text", text: textOf(content) }];
    const msg: ChatMessage = {
      type: "message",
      key: `${run.session}:${out.length}`,
      role: "agent",
      at,
      text: "",
      tools: [],
    };
    for (const p of parts as {
      type?: string;
      text?: string;
      name?: string;
      id?: string;
      input?: unknown;
    }[]) {
      if (p.type === "text" && p.text?.trim()) msg.text += (msg.text ? "\n\n" : "") + p.text.trim();
      if (p.type === "tool_use") {
        const t: ChatTool = {
          name: String(p.name),
          input: cut(JSON.stringify(p.input ?? {})),
          result: null,
          error: false,
        };
        tools.set(String(p.id), t);
        msg.tools.push(t);
      }
    }
    if (msg.text || msg.tools.length) out.push(msg);
  }
  return out;
}

/** CHAT-8: the owner's messages of an intent, kept in `meta` as `chat:<intent>`. */
export interface Queued {
  id: number;
  at: number;
  by: string;
  text: string;
  /** `queued` until the intent waits on the owner; then `sent`, or `failed` with the reason. */
  status: "queued" | "sent" | "failed";
  note: string | null;
}

export function queuedOf(db: Db, intent: string): Queued[] {
  try {
    return JSON.parse(db.meta(`chat:${intent}`) ?? "[]") as Queued[];
  } catch {
    return [];
  }
}

export function saveQueued(db: Db, intent: string, list: Queued[]): void {
  db.setMeta(`chat:${intent}`, JSON.stringify(list));
}

/** Every intent with a message still queued. */
export function intentsWithQueued(db: Db): string[] {
  return db
    .all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key LIKE 'chat:%'")
    .filter((r) => r.value.includes('"status":"queued"'))
    .map((r) => r.key.slice(5));
}

const WORDS: Record<string, string> = {
  design: "Spec",
  plan: "Plan",
  build: "Build",
  verify: "Verify",
  proof: "Proof",
  review: "Review",
  gate: "Gate",
  ship: "Ship",
  e2e: "Live checks",
};

/**
 * CHAT-3..8: the thread of an intent, oldest first: a divider per run, its transcript, Towercab's moves,
 * and the owner's messages. `before` pages back (CHAT-6): items older than that index.
 */
export function chatOf(
  d: { db: Db; runsRoot: string; claudeHome?: string },
  intent: string,
  missions: Mission[],
  before?: number,
): ChatPage {
  const items: ChatItem[] = [];
  let missing = 0;
  const seen = new Set<string>();
  for (const r of runsOf(d.runsRoot, intent)) {
    const label = `${WORDS[r.stage] ?? r.stage} · ${r.kind} ${r.n}`;
    items.push({ type: "divider", key: `run:${r.file}`, at: r.at, text: label });
    // A resumed session's transcript holds the earlier turns too: each session is read once.
    if (seen.has(r.session)) continue;
    seen.add(r.session);
    const p = transcriptPath(r, d.claudeHome);
    if (!p) {
      missing++;
      items.push({
        type: "event",
        key: `gone:${r.file}`,
        at: r.at,
        text: "This run's conversation is no longer on this machine; only its result is kept.",
        tone: "muted",
      });
      continue;
    }
    for (const m of parseTranscript(readFileSync(p, "utf8"), r)) items.push({ ...m, at: Math.max(m.at, 0) });
  }
  for (const m of missions) {
    for (const t of d.db.all<{
      id: number;
      at: number;
      from_stage: string;
      event: string;
      to_stage: string;
      why: string | null;
    }>(
      "SELECT id, at, from_stage, event, to_stage, why FROM transitions WHERE mission = ? ORDER BY id",
      m.id,
    )) {
      items.push({
        type: "event",
        key: `t:${t.id}`,
        at: t.at,
        text: `${t.from_stage} → ${t.to_stage}${t.why ? `: ${t.why}` : ""}`,
        tone: /blocked|failed|red|stopped/.test(`${t.to_stage} ${t.why ?? ""}`) ? "warn" : "muted",
      });
    }
  }
  for (const q of queuedOf(d.db, intent)) {
    items.push({
      type: "message",
      key: `q:${q.id}`,
      role: "owner",
      at: q.at,
      text: q.text,
      tools: [],
      status: q.status,
      note: q.note,
      by: q.by,
    });
  }
  items.sort((a, b) => a.at - b.at);
  const end = before === undefined ? items.length : Math.max(0, Math.min(before, items.length));
  const start = Math.max(0, end - PAGE);
  const live = missions.find((m) => !ENDED.includes(m.stage)) ?? null;
  return {
    intent,
    items: items.slice(start, end),
    before: start > 0 ? start : null,
    total: items.length,
    missing,
    composer: composerOf(live, missions.length === 0),
  };
}

/** CHAT-8: the intent waits on the owner (an approval or a block, any phase) and no run of it is going. */
export function waitsOnOwner(m: Mission): boolean {
  return (WAIT_STAGES as readonly string[]).includes(m.stage) && !m.child_pid;
}

const ENDED = ["done", "stopped", "unverified"];

/** CHAT-8: an intent that ran and has no attempt open any more takes no message. */
export function hasEnded(missions: Mission[]): boolean {
  return missions.length > 0 && missions.every((m) => ENDED.includes(m.stage));
}

/** CHAT-8, CHAT-9: what the composer may do now, in words. */
export function composerOf(m: Mission | null, notStarted = false): ChatPage["composer"] {
  if (!m && notStarted)
    return {
      open: true,
      note: "It hasn't started: your message waits and goes in when it first waits on you.",
    };
  if (!m) return { open: false, note: "This intent has ended. Write a new intent to change it further." };
  if (waitsOnOwner(m)) return { open: true, note: "It waits on you: your message goes to it now." };
  return { open: true, note: "A worker is busy: your message waits and goes in when it next waits on you." };
}
