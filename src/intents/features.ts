// A repo's feature list (INT-37..40): `features/<repo>.md` in the intents repo, one short business
// sentence per line with its status. Towercab edits it line by line, so the owner's own lines, notes and
// wording stay byte-identical.

import { isId } from "./id.ts";

export type FeatureStatus = "live" | "in progress" | "planned";

export const FEATURE_STATUSES: FeatureStatus[] = ["live", "in progress", "planned"];

/** One feature line as read. */
export interface Feature {
  status: FeatureStatus;
  text: string;
  /** The intent the line was added for (its `<!-- intent <id> -->` tag), else null. */
  intent: string | null;
}

/** The longest feature sentence Towercab writes. */
export const FEATURE_MAX = 200;

const LINE = /^\s*[-*]\s+\[(live|in progress|planned)\]\s+(.*?)\s*$/i;
const TAG = /\s*<!--\s*intent\s+(\S+)\s*-->\s*$/;

/** `features/<repo>.md`. */
export function featuresPath(repo: string): string {
  return `features/${repo}.md`;
}

/** A repo name that can name a file: `[A-Za-z0-9._-]+`, not starting with `-`, not `.` or `..`. */
export function isRepoName(repo: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(repo) && !repo.startsWith("-") && repo !== "." && repo !== "..";
}

/** A new file's head: a title and how to edit it. */
export function featuresHeader(repo: string): string {
  return [
    `# ${repo}: what people can do`,
    "",
    "<!-- One feature per line: `- [live]`, `- [in progress]` or `- [planned]`, then one short sentence",
    "about what a person can do. Towercab adds a line when it starts an intent, marks it live when the",
    "intent is done, and removes it when the intent is dropped; it finds the line by the intent comment",
    "at its end. Edit, reorder or add lines freely. -->",
    "",
  ].join("\n");
}

/** One line of the file as a feature, or null for any other line (title, notes, blank). */
export function parseLine(line: string): Feature | null {
  const m = LINE.exec(line);
  if (!m) return null;
  let text = m[2]!;
  let intent: string | null = null;
  const t = TAG.exec(text);
  if (t && isId(t[1]!)) {
    intent = t[1]!;
    text = text.slice(0, t.index);
  }
  text = text.trim();
  if (!text) return null;
  return { status: m[1]!.toLowerCase() as FeatureStatus, text, intent };
}

/** Every feature line of `text`, in file order. */
export function parseFeatures(text: string | null): Feature[] {
  if (!text) return [];
  return text.split("\n").flatMap((l) => {
    const f = parseLine(l);
    return f ? [f] : [];
  });
}

/**
 * Model or title text as one feature sentence: one line, no list marker, heading, status word or HTML
 * comment of its own, at most FEATURE_MAX characters; null when nothing is left.
 */
export function cleanSentence(s: string): string | null {
  let t = s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/<!--.*?-->/g, " ")
    .replace(/<!--|-->/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (;;) {
    const before = t;
    t = t
      .replace(/^(?:[-*+]\s+|#+\s*|>\s*|\d+[.)]\s+)/, "")
      .replace(/^\[[^\]]*\]\s*/, "")
      .trim();
    if (t === before) break;
  }
  if (t.length > FEATURE_MAX) t = `${t.slice(0, FEATURE_MAX - 1).trimEnd()}…`;
  return t ? t : null;
}

const lineOf = (status: FeatureStatus, text: string, intent: string | null) =>
  `- [${status}] ${text}${intent ? ` <!-- intent ${intent} -->` : ""}`;

function linesOf(text: string | null, repo: string): string[] {
  const base = text ?? featuresHeader(repo);
  const lines = base.split("\n");
  // The trailing newline is put back on output.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const joined = (lines: string[]) => `${lines.join("\n")}\n`;

/** Index of the line just after the last feature line, or the end. */
function afterLast(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (parseLine(lines[i]!)) return i + 1;
  return lines.length;
}

/**
 * INT-38: the line of `intent` gets `status` (its text kept, so the owner's wording stays); without one,
 * a line `- [<status>] <title> <!-- intent <id> -->` is added after the last feature line. Null when the
 * file doesn't change or the title cleans to nothing.
 */
export function setFeature(
  text: string | null,
  repo: string,
  f: { intent: string; title: string; status: FeatureStatus },
): string | null {
  const lines = linesOf(text, repo);
  const at = lines.findIndex((l) => parseLine(l)?.intent === f.intent);
  if (at >= 0) {
    const cur = lines[at]!;
    const next = cur.replace(/\[(live|in progress|planned)\]/i, `[${f.status}]`);
    if (next === cur) return null;
    lines[at] = next;
    return joined(lines);
  }
  const title = cleanSentence(f.title);
  if (!title) return null;
  let i = afterLast(lines);
  // A first feature after the header's prose gets a blank line before it.
  if (i === lines.length && i > 0 && lines[i - 1]!.trim() !== "" && !parseLine(lines[i - 1]!)) {
    lines.push("");
    i++;
  }
  lines.splice(i, 0, lineOf(f.status, title, f.intent));
  return joined(lines);
}

/** INT-38: the line of `intent` removed; null when there is none. */
export function removeFeature(text: string | null, intent: string): string | null {
  if (text === null) return null;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => parseLine(l)?.intent === intent);
  if (at < 0) return null;
  lines.splice(at, 1);
  return lines.join("\n");
}

/**
 * INT-39: the backfill's sentences replace the live lines no intent added; every other line stays
 * where it is. They go where the first such line was, else before the first feature line, else at the
 * end. Null when the file doesn't change.
 */
export function replaceLive(text: string | null, repo: string, sentences: string[]): string | null {
  const lines = linesOf(text, repo);
  const fresh = sentences.map((s) => lineOf("live", s, null));
  let at = -1;
  const kept: string[] = [];
  for (const l of lines) {
    const f = parseLine(l);
    if (f && f.status === "live" && f.intent === null) {
      if (at < 0) at = kept.length;
      continue;
    }
    kept.push(l);
  }
  if (at < 0) {
    const first = kept.findIndex((l) => parseLine(l) !== null);
    at = first >= 0 ? first : kept.length;
    if (first < 0 && at > 0 && kept[at - 1]!.trim() !== "") {
      kept.push("");
      at++;
    }
  }
  kept.splice(at, 0, ...fresh);
  const out = joined(kept);
  return out === text ? null : out;
}

/** Whether the file has a feature line no intent added (the backfill or the owner wrote it). */
export function hasOwnLines(text: string | null): boolean {
  return parseFeatures(text).some((f) => f.intent === null);
}
