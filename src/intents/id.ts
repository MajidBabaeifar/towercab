// Intent IDs, slugs and folder names (INT-3).

import { NoOpenIntentError, RefusedError } from "./types.ts";

const ID = /^(\d{6})-(\d{4})(?:-(\d+))?$/;
const DIR = /^(\d{6}-\d{4}(?:-\d+)?)-([a-z][a-z0-9-]*)$/;
const DIR_ID = /^(\d{6}-\d{4}(?:-\d+)?)(?:-|$)/;

/** Longest slug before the `n` prefix. */
export const SLUG_MAX = 48;

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYMMDD-HHMM` of `now` in local time; a clash with `taken` gets `-2`, `-3`, … (never reused). */
export function newId(now: Date, taken: Set<string>): string {
  const base =
    pad(now.getFullYear() % 100) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "-" +
    pad(now.getHours()) +
    pad(now.getMinutes());
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** `YYMMDD-HHMM` with an optional `-<n>`. */
export function isId(s: string): boolean {
  return ID.test(s);
}

/** Sort key `[YYMMDD, HHMM, suffix]`, no suffix = 1; not an ID sorts last. */
export function sortKey(id: string): [number, number, number] {
  const m = ID.exec(id);
  if (!m) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return [Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
}

/** Compare two IDs by `sortKey`, oldest first. */
export function cmpIds(a: string, b: string): number {
  const [x, y] = [sortKey(a), sortKey(b)];
  for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return x[k]! < y[k]! ? -1 : 1;
  return 0;
}

/** The slug of a title: lowercase ASCII `[a-z0-9-]`, at most 48 characters, `intent` if empty, `n` before a digit. */
export function slugOf(title: string): string {
  let out = "";
  let dash = false;
  for (const ch of title) {
    if (ch === "'" || ch === "’") continue;
    const c = /^[A-Z]$/.test(ch) ? ch.toLowerCase() : ch;
    if (/^[a-z0-9]$/.test(c)) {
      if (dash && out) out += "-";
      dash = false;
      out += c;
    } else dash = true;
  }
  out = out.slice(0, SLUG_MAX).replace(/^-+|-+$/g, "");
  if (!out) out = "intent";
  if (/^[0-9]/.test(out)) out = `n${out}`;
  return out;
}

/** `<id>-<slug>` → `{ id, slug }`; the ID part is greedy (`-2` belongs to the ID). */
export function splitDir(name: string): { id: string; slug: string } | null {
  const m = DIR.exec(name);
  return m ? { id: m[1]!, slug: m[2]! } : null;
}

/** The ID a folder name starts with (then `-` or the end), whatever follows: it is taken either way. */
export function dirId(name: string): string | null {
  return DIR_ID.exec(name)?.[1] ?? null;
}

/** An exact ID, else the one ID ending with `suffix` (INT-3); otherwise a `RefusedError`. */
export function resolve(suffix: string, ids: Iterable<string>): string {
  const all = [...new Set(ids)].sort();
  if (all.includes(suffix)) return suffix;
  const matches = suffix ? all.filter((id) => id.endsWith(suffix)) : [];
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new NoOpenIntentError(`no open intent matches ${suffix}`);
  throw new RefusedError(`${suffix} matches ${matches.length} intents: ${matches.join(", ")}`);
}
