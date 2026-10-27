// Log lines (LOOP-21): one readable line to stderr, the whole text to <home>/towercab.log.

import { appendFileSync, renameSync, statSync } from "node:fs";

export const MAX = 300;
export const ROTATE = 5 * 1024 * 1024;

let file: string | null = null;
const lastWarn = new Map<string, string>();

/** Where full multi-line messages go; null = nowhere (tests, the CLI). */
export function init(path: string | null): void {
  file = path;
}

/** The message's first meaningful line, control characters as spaces, cut to MAX. */
export function line(text: string): { line: string; more: number } {
  const lines = text.split("\n").filter((l) => {
    const t = l.trim();
    return t !== "" && !/^(Usage|Flags):/.test(t);
  });
  const first = (lines[0] ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const cut = first.length > MAX ? `${first.slice(0, MAX - 1)}…` : first;
  return { line: cut, more: Math.max(0, lines.length - 1) };
}

/** Write one line to stderr; a longer message also goes whole to the log file. */
export function emit(text: string, now: Date = new Date()): string {
  const { line: l, more } = line(text);
  let out = l;
  if (more > 0) out += ` (+${more} lines)`;
  if (file && (more > 0 || l.length < text.trim().length)) {
    try {
      rotate(file);
      appendFileSync(file, `--- ${now.toISOString()}\n${text.trimEnd()}\n`);
      out += ` · full: ${file}`;
    } catch {
      // The journal line still goes out.
    }
  }
  process.stderr.write(`towercab: ${out}\n`);
  return out;
}

/** A warning that may repeat every pass: logged once until its text changes. */
export function warn(key: string, text: string): void {
  if (lastWarn.get(key) === text) return;
  lastWarn.set(key, text);
  emit(text);
}

export function clearWarn(key: string): void {
  lastWarn.delete(key);
}

function rotate(path: string): void {
  try {
    if (statSync(path).size > ROTATE) renameSync(path, `${path}.1`);
  } catch {
    // No file yet.
  }
}
