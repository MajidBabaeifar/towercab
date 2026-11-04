// `intent.md` (INT-2, INT-5, INT-15): front matter read with `yaml`, written line by line, so an
// untouched file renders back byte-identical and a write replaces only the changed key's lines.

import { parse as parseYaml } from "yaml";
import { isRepoName } from "../config.ts";
import { isId } from "./id.ts";
import type { Intent, IntentEdit } from "./types.ts";

/** Stage values Towercab writes (INT-5). */
export const STAGES = ["spec", "plan", "code", "done", "dropped"] as const;

/** v1's stage values and the phase they read as (INT-5 Decisions). */
export const LEGACY_STAGES: Record<string, string> = {
  design: "spec",
  build: "code",
  test: "code",
  deploy: "code",
  maintain: "code",
};

type Kind = "repo" | "score" | "str" | "after" | "list" | "time" | "stage" | "float" | "seconds" | "count";
type Value = number | string | string[];

const KINDS: Record<string, Kind> = {
  repo: "repo",
  u: "score",
  i: "score",
  a: "score",
  model: "str",
  review: "str",
  source: "str",
  issue: "str",
  waiting: "str",
  spec_pr: "str",
  plan_pr: "str",
  pr: "str",
  retry: "str",
  lower_why: "str",
  verified: "str",
  steps_left: "str",
  after: "after",
  unlock: "list",
  network: "list",
  started: "time",
  finished: "time",
  stage: "stage",
  cost: "float",
  agent_time: "seconds",
  attempts: "count",
};

const DESCRIBE: Record<Kind, string> = {
  repo: "a repo name ([A-Za-z0-9._-], no leading -, not . or ..)",
  score: "an integer 1-5",
  str: "a string",
  after: "a list of ids",
  list: "a list of strings",
  time: "an RFC 3339 time with offset",
  stage: `one of ${STAGES.join(", ")}`,
  float: "a number",
  seconds: "an integer >= 0 (seconds)",
  count: "an integer >= 1",
};

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]|$)/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** RFC 3339 with offset (INT-2's `started`, INT-5's `finished`). */
export function isTime(s: string): boolean {
  return RFC3339.test(s) && !Number.isNaN(Date.parse(s.replace(" ", "T")));
}

const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, "0");

/** `YYYY-MM-DDTHH:MM:SS+hh:mm` in local time, to the second. */
export function localTime(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

/** `YYYY-MM-DD HH:MM` in local time (an `## Answers` line, INT-15). */
export function answerTime(d: Date): string {
  return localTime(d).slice(0, 16).replace("T", " ");
}

/** Every run of whitespace (line breaks too) → one space. */
export function oneLine(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/** A known field's value checked; the same rules for parse and `setField`. */
function check(key: string, kind: Kind, v: unknown, reading: boolean): Value {
  const bad = () => new Error(`${key} must be ${DESCRIBE[kind]}`);
  const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
  const strings = (l: unknown): l is string[] => Array.isArray(l) && l.every((s) => typeof s === "string");
  switch (kind) {
    case "repo":
      if (typeof v === "string" && isRepoName(v)) return v;
      throw bad();
    case "score":
      if (isInt(v) && v >= 1 && v <= 5) return v;
      throw bad();
    case "str":
      if (typeof v === "string") return v;
      throw bad();
    case "after":
      // One ID counts as a one-item list (only for `after`).
      if (typeof v === "string" && isId(v)) return [v];
      if (strings(v) && v.every(isId)) return v;
      throw bad();
    case "list":
      if (strings(v)) return v;
      throw bad();
    case "time":
      if (typeof v === "string" && isTime(v)) return v;
      throw bad();
    case "stage":
      if (
        typeof v === "string" &&
        ((STAGES as readonly string[]).includes(v) || (reading && v in LEGACY_STAGES))
      )
        return v;
      throw bad();
    case "float":
      if (typeof v === "number" && Number.isFinite(v)) return v;
      throw bad();
    case "seconds":
      if (isInt(v) && v >= 0) return v;
      throw bad();
    case "count":
      if (isInt(v) && v >= 1 && v <= 2 ** 32 - 1) return v;
      throw bad();
  }
}

function readsBack(doc: string, want: unknown): boolean {
  // Line breaks and other control characters (not printable in YAML) are always quoted.
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(doc)) return false;
  try {
    const got = (parseYaml(doc) as Record<string, unknown> | null)?.k;
    return JSON.stringify(got) === JSON.stringify(want);
  } catch {
    return false;
  }
}

function quote(s: string): string {
  let out = '"';
  for (const c of s) {
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (/[\u0000-\u001f\u007f-\u009f]/.test(c))
      out += `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
    else out += c;
  }
  return `${out}"`;
}

/** How a value is written: strings plain when they read back unchanged, else double-quoted; cost with 2 decimals; lists in flow style. */
export function formatValue(key: string, v: Value): string {
  if (typeof v === "number") return KINDS[key] === "float" ? v.toFixed(2) : String(v);
  if (typeof v === "string") return readsBack(`k: ${v}`, v) ? v : quote(v);
  return `[${v.map((s) => (readsBack(`k: [${s}]`, [s]) ? s : quote(s))).join(", ")}]`;
}

/** One top-level key's lines, or a standalone blank / `#` line. */
interface Segment {
  key: string | null;
  text: string;
}

const eolStripped = (l: string) => l.replace(/\r?\n$/, "");

function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The first `# ` line, without an `Intent: ` prefix. */
function titleOf(body: string): string | null {
  for (const raw of body.split("\n")) {
    const l = raw.replace(/\r$/, "");
    if (!l.startsWith("# ")) continue;
    const t = l.slice(2).trim();
    const title = t.startsWith("Intent:") ? t.slice("Intent:".length).trim() : t;
    return title || null;
  }
  return null;
}

/** A fence toggle: ``` or ~~~ at the start of a (trimmed) line. */
function fenceOf(line: string): string | null {
  const t = line.trimStart();
  return t.startsWith("```") ? "`" : t.startsWith("~~~") ? "~" : null;
}

/** The 1-based body line where a fence is opened and never closed, or null (INT-30). */
function unclosedFence(body: string): number | null {
  let fence: string | null = null;
  let opened = 0;
  let n = 0;
  for (const line of linesOf(body)) {
    n++;
    const f = fenceOf(eolStripped(line));
    if (!f) continue;
    if (fence === null) {
      fence = f;
      opened = n;
    } else if (fence === f) fence = null;
  }
  return fence === null ? null : opened;
}

function checkFences(text: string, bodyLine: number): void {
  const n = unclosedFence(text);
  if (n !== null) throw new Error(`unclosed code fence at line ${bodyLine + n - 1}`);
}

interface Span {
  title: string;
  start: number;
  /** Where the content starts (after the heading line). */
  content: number;
  end: number;
}

/** `## <title>` sections of a body, outside fences; each ends at the next `# ` or `## ` line. */
function spans(body: string): Span[] {
  const out: Span[] = [];
  let pos = 0;
  let fence: string | null = null;
  let cur: Span | null = null;
  for (const line of linesOf(body)) {
    const l = eolStripped(line).replace(/\r$/, "");
    const f = fenceOf(l);
    if (f) {
      if (fence === null) fence = f;
      else if (fence === f) fence = null;
    } else if (fence === null && (l.startsWith("# ") || l.startsWith("## "))) {
      if (cur) {
        cur.end = pos;
        out.push(cur);
        cur = null;
      }
      if (l.startsWith("## "))
        cur = { title: l.slice(3).trim(), start: pos, content: pos + line.length, end: 0 };
    }
    pos += line.length;
  }
  if (cur) {
    cur.end = pos;
    out.push(cur);
  }
  return out;
}

/** A parsed `intent.md`: an `Intent` view of it plus line-level edits (`IntentEdit`). */
export class IntentFile implements IntentEdit {
  id = "";
  slug = "";
  /** `intents/<id>-<slug>` or `done/<id>-<slug>` (set by the store). */
  dir = "";
  private open: string;
  private segments: Segment[];
  private close: string;
  private body: string;
  private values: Map<string, Value>;
  private titleText: string;

  private constructor(open: string, segments: Segment[], close: string, body: string) {
    this.open = open;
    this.segments = segments;
    this.close = close;
    this.body = body;
    this.values = readValues(segments);
    const title = titleOf(body);
    if (!title) throw new Error("no title: the body needs a `# ` line");
    this.titleText = title;
    checkFences(body, this.bodyLine);
  }

  /** The 1-based file line where the body starts. */
  private get bodyLine(): number {
    const head = this.open + this.segments.map((s) => s.text).join("") + this.close;
    return (head.match(/\n/g)?.length ?? 0) + 1;
  }

  /** Parse an `intent.md`; the error's message is the reason shown under Can't read (INT-11). */
  static parse(text: string): IntentFile {
    const lines = linesOf(text);
    const first = lines[0];
    if (first === undefined || eolStripped(first).replace(/^﻿/, "").replace(/\r$/, "") !== "---") {
      throw new Error("no front matter: the first line must be ---");
    }
    let consumed = first.length;
    const segments: Segment[] = [];
    let close: string | null = null;
    for (let n = 1; n < lines.length; n++) {
      const line = lines[n]!;
      consumed += line.length;
      const l = eolStripped(line).replace(/\r$/, "");
      if (l === "---") {
        close = line;
        break;
      }
      if (l.trim() === "" || l.startsWith("#")) {
        segments.push({ key: null, text: line });
      } else if (l.startsWith(" ") || l.startsWith("\t") || l === "-" || l.startsWith("- ")) {
        // A continuation; blank or comment lines between it and its key join the key.
        const owner = segments.findLastIndex((s) => s.key !== null);
        if (owner < 0) throw new Error(`front matter line ${n + 1}: no key before it`);
        const joined = segments
          .splice(owner + 1)
          .map((s) => s.text)
          .join("");
        segments[owner]!.text += joined + line;
      } else {
        const m = KEY.exec(l);
        if (!m) throw new Error(`front matter line ${n + 1}: not a \`key:\` line at column 0`);
        const key = m[1]!;
        if (segments.some((s) => s.key === key)) throw new Error(`duplicate key ${key}`);
        segments.push({ key, text: line });
      }
    }
    if (close === null) throw new Error("front matter has no closing ---");
    return new IntentFile(first, segments, close, text.slice(consumed));
  }

  /** The file's bytes: untouched lines exactly as read. */
  render(): string {
    return this.open + this.segments.map((s) => s.text).join("") + this.close + this.body;
  }

  private get eol(): string {
    return this.open.endsWith("\r\n") ? "\r\n" : "\n";
  }

  /** Whether the front matter has `key` (known or not). */
  has(key: string): boolean {
    return this.segments.some((s) => s.key === key);
  }

  /** Set a known field (INT-5): its lines become one `key: value` line in place, a new key goes last; null removes it. */
  setField(key: string, value: string | number | string[] | null): void {
    if (value === null) {
      this.removeField(key);
      return;
    }
    const kind = KINDS[key];
    if (!kind) throw new Error(`${key} is not a Towercab field`);
    const v = check(key, kind, value, false);
    const old = this.values.get(key);
    if (old !== undefined && JSON.stringify(old) === JSON.stringify(v)) return;
    const line = `${key}: ${formatValue(key, v)}${this.eol}`;
    const next = this.segments.map((s) => ({ ...s }));
    const seg = next.find((s) => s.key === key);
    if (seg) seg.text = line;
    else next.push({ key, text: line });
    this.values = readValues(next);
    this.segments = next;
  }

  /** Remove a known field's lines; absent → nothing changes. */
  removeField(key: string): void {
    if (!KINDS[key]) throw new Error(`${key} is not a Towercab field`);
    const next = this.segments.filter((s) => s.key !== key);
    if (next.length === this.segments.length) return;
    this.values = readValues(next);
    this.segments = next;
  }

  /** The body section `## <title>` as written (up to the next `# `/`## ` line), or null. */
  section(title: string): string | null {
    const s = spans(this.body).find((x) => x.title === title);
    return s ? this.body.slice(s.content, s.end) : null;
  }

  /**
   * Replace `## <title>` whole (INT-15): the old one removed with the blank line before it, the new
   * one appended last, but before `## Answers`; empty text only removes it. A line starting with `#`
   * is escaped (`\#`) so it can't end the section.
   */
  setSection(title: string, text: string): void {
    let body = removeSection(this.body, title, this.eol);
    let answers: string | null = null;
    if (title !== "Answers" && text.trim()) {
      const s = spans(body).find((x) => x.title === "Answers");
      if (s) {
        answers = body.slice(s.content, s.end);
        body = removeSection(body, "Answers", this.eol);
      }
    }
    body = appendSection(body, title, text, this.eol);
    if (answers !== null) body = appendSection(body, "Answers", answers, this.eol);
    const t = titleOf(body);
    if (!t) throw new Error("no title: the body needs a `# ` line");
    checkFences(body, this.bodyLine);
    this.body = body;
    this.titleText = t;
  }

  /**
   * INT-34: rename the intent: only the title line (the first `# ` line) changes, keeping its
   * `Intent: ` prefix and line ending; every other line stays byte-identical.
   */
  setTitle(title: string): void {
    const t = title.trim();
    if (!t || /[\r\n]/.test(title)) throw new Error("the title must be one non-empty line");
    const lines = linesOf(this.body);
    const n = lines.findIndex((l) => l.startsWith("# "));
    if (n < 0) throw new Error("no title: the body needs a `# ` line");
    const old = lines[n]!;
    const eol = old.endsWith("\r\n") ? "\r\n" : old.endsWith("\n") ? "\n" : "";
    const prefix = old.slice(2).trimStart().startsWith("Intent:") ? "Intent: " : "";
    lines[n] = `# ${prefix}${t}${eol}`;
    const body = lines.join("");
    checkFences(body, this.bodyLine);
    this.body = body;
    this.titleText = titleOf(body)!;
  }

  /** Append `- <YYYY-MM-DD HH:MM>: <text>` to `## Answers` (last). */
  addAnswer(text: string, at: Date): void {
    const t = oneLine(text);
    if (!t) throw new Error("an answer can't be empty");
    const old = (this.section("Answers") ?? "").trim();
    this.setSection("Answers", `${old ? `${old}\n` : ""}- ${answerTime(at)}: ${t}`);
  }

  /** The `Intent` as it is now. */
  get intent(): Intent {
    const v = this.values;
    const str = (k: string) => {
      const x = v.get(k);
      return typeof x === "string" ? x : null;
    };
    const num = (k: string) => {
      const x = v.get(k);
      return typeof x === "number" ? x : null;
    };
    const list = (k: string) => {
      const x = v.get(k);
      return Array.isArray(x) ? [...x] : [];
    };
    const stage = str("stage");
    const sections = new Map<string, string>();
    for (const s of spans(this.body)) {
      if (!sections.has(s.title)) sections.set(s.title, this.body.slice(s.content, s.end).trim());
    }
    return {
      id: this.id,
      slug: this.slug,
      dir: this.dir,
      done: this.dir.startsWith("done/"),
      title: this.titleText,
      repo: str("repo") ?? "",
      u: num("u"),
      i: num("i"),
      a: num("a"),
      after: list("after"),
      model: str("model"),
      review: str("review"),
      source: str("source"),
      issue: str("issue"),
      started: str("started"),
      unlock: list("unlock"),
      network: list("network"),
      stage: stage === null ? null : (LEGACY_STAGES[stage] ?? stage),
      waiting: str("waiting"),
      specPr: str("spec_pr"),
      planPr: str("plan_pr"),
      pr: str("pr"),
      retry: str("retry"),
      cost: num("cost"),
      agentTime: num("agent_time"),
      attempts: num("attempts"),
      finished: str("finished"),
      lowerWhy: str("lower_why"),
      verified: str("verified"),
      stepsLeft: str("steps_left"),
      sections,
      text: this.render(),
    };
  }

  /** A copy to edit (a store write works on one, so a thrown error changes nothing). */
  clone(): IntentFile {
    const c = IntentFile.parse(this.render());
    [c.id, c.slug, c.dir] = [this.id, this.slug, this.dir];
    return c;
  }
}

/** Parse `text` into an `Intent` (id, slug and dir empty); throws with the Can't read reason. */
export function parseIntent(text: string): Intent {
  return IntentFile.parse(text).intent;
}

function readValues(segments: Segment[]): Map<string, Value> {
  let doc: unknown;
  try {
    doc = parseYaml(segments.map((s) => s.text).join(""));
  } catch (e) {
    throw new Error(`front matter: ${(e as Error).message.split("\n")[0]}`);
  }
  if (doc !== null && doc !== undefined && (typeof doc !== "object" || Array.isArray(doc))) {
    throw new Error("front matter is not a mapping");
  }
  const map = (doc ?? {}) as Record<string, unknown>;
  const values = new Map<string, Value>();
  for (const s of segments) {
    if (s.key === null) continue;
    const kind = KINDS[s.key];
    if (!kind) continue;
    values.set(s.key, check(s.key, kind, map[s.key] ?? null, true));
  }
  if (!values.has("repo")) throw new Error("repo is missing");
  return values;
}

function removeSection(body: string, title: string, eol: string): string {
  const s = spans(body).find((x) => x.title === title);
  if (!s) return body;
  const blank = eol + eol;
  const start = body.slice(0, s.start).endsWith(blank) ? s.start - eol.length : s.start;
  return body.slice(0, start) + body.slice(s.end);
}

function appendSection(body: string, title: string, text: string, eol: string): string {
  const t = text.trim();
  if (!t) return body;
  let out = body;
  if (out && !out.endsWith("\n")) out += eol;
  out += `${eol}## ${title}${eol}${eol}`;
  for (const raw of t.split("\n")) {
    const line = raw.replace(/\r$/, "");
    out += (line.startsWith("#") ? "\\" : "") + line + eol;
  }
  return out;
}
