// PIP-167: the rules that resolve a conflict where both sides only added lines. Pure text in, text out;
// `mechanical.ts` reads the files from git and writes the results back.

/** One conflict hunk of a `diff3`-style file: what the merge base, our side (the PR) and theirs had. */
export interface Hunk {
  base: string[];
  ours: string[];
  theirs: string[];
}

export type Segment = { text: string[] } | { hunk: Hunk };

/** The segments of a file with `diff3` conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`). */
export function splitConflicts(file: string): Segment[] | null {
  const lines = file.split("\n");
  const out: Segment[] = [];
  let plain: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("<<<<<<< ")) {
      plain.push(line);
      i++;
      continue;
    }
    const part: Record<"ours" | "base" | "theirs", string[]> = { ours: [], base: [], theirs: [] };
    let into: keyof typeof part = "ours";
    let closed = false;
    for (i++; i < lines.length; i++) {
      const l = lines[i]!;
      if (into === "ours" && l.startsWith("||||||| ")) into = "base";
      else if (into === "base" && l === "=======") into = "theirs";
      else if (into === "theirs" && l.startsWith(">>>>>>> ")) {
        closed = true;
        i++;
        break;
      } else if (l.startsWith("<<<<<<< ")) return null;
      else part[into].push(l);
    }
    if (!closed) return null;
    if (plain.length) out.push({ text: plain });
    plain = [];
    out.push({ hunk: part });
  }
  if (plain.length) out.push({ text: plain });
  return out;
}

/**
 * The lines of `side` between the lines of `base` when `base` is a subsequence of it: `gaps[k]` is what
 * the side inserted before `base[k]` (the last entry: after the last line). Null when the side removed
 * or changed a line of `base`.
 */
function insertions(base: string[], side: string[]): string[][] | null {
  const gaps: string[][] = [[]];
  let k = 0;
  for (const line of side) {
    if (k < base.length && line === base[k]) {
      k++;
      gaps.push([]);
    } else gaps[k]!.push(line);
  }
  return k === base.length ? gaps : null;
}

const IMPORT = /^import (type )?\{([^}]*)\}\s*from\s*(["'])([^"']+)\3;?\s*$/;

interface Import {
  typeOnly: boolean;
  names: string[];
  module: string;
  quote: string;
  semi: boolean;
}

function parseImport(line: string): Import | null {
  const m = IMPORT.exec(line);
  if (!m) return null;
  const names = m[2]!
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  return { typeOnly: Boolean(m[1]), names, module: m[4]!, quote: m[3]!, semi: line.trimEnd().endsWith(";") };
}

const byName = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

function importLine(i: Import, names: string[]): string {
  const sorted = [...new Set(names)].sort(byName);
  return `import ${i.typeOnly ? "type " : ""}{ ${sorted.join(", ")} } from ${i.quote}${i.module}${i.quote}${i.semi ? ";" : ""}`;
}

/** Imports of one module (and kind) that sit in `lines` become one sorted import, at the first one's place. */
function mergeImports(lines: string[]): string[] {
  const parsed = lines.map(parseImport);
  const out: (string | null)[] = [...lines];
  const first = new Map<string, number>();
  const merged = new Set<number>();
  parsed.forEach((p, idx) => {
    if (!p) return;
    const key = `${p.typeOnly}:${p.module}`;
    const at = first.get(key);
    if (at === undefined) {
      first.set(key, idx);
      return;
    }
    parsed[at]!.names.push(...p.names);
    merged.add(at);
    out[idx] = null;
  });
  for (const at of merged) out[at] = importLine(parsed[at]!, parsed[at]!.names);
  return out.filter((l): l is string => l !== null);
}

/** Both sides added names to the same import line: one import with every name, sorted. */
function importEdit(h: Hunk): string[] | null {
  if (h.base.length !== 1 || h.ours.length !== 1 || h.theirs.length !== 1) return null;
  const [b, o, t] = [h.base[0]!, h.ours[0]!, h.theirs[0]!].map(parseImport);
  if (!b || !o || !t) return null;
  if (
    b.module !== o.module ||
    b.module !== t.module ||
    b.typeOnly !== o.typeOnly ||
    b.typeOnly !== t.typeOnly
  )
    return null;
  const kept = (side: Import) => b.names.every((n) => side.names.includes(n));
  if (!kept(o) || !kept(t)) return null;
  return [importLine(o, [...o.names, ...t.names])];
}

const RANGE = /^([A-Z][A-Z0-9]*)-(\d+)(?:\.\.(\d+))?$/;
const STATUS = /^(\*\*Status:\*\* Live: )(.*?)((?: · .*)?)$/;

/** `PIP-1..54, PIP-70` → the IDs, by prefix; null for anything else (a bare `Live`, a `Draft`). */
function expandIds(list: string): Map<string, Set<number>> | null {
  const ids = new Map<string, Set<number>>();
  for (const raw of list.split(",")) {
    const m = RANGE.exec(raw.trim());
    if (!m) return null;
    const from = Number(m[2]);
    const to = m[3] === undefined ? from : Number(m[3]);
    if (to < from || to - from > 10_000) return null;
    const set = ids.get(m[1]!) ?? new Set<number>();
    for (let n = from; n <= to; n++) set.add(n);
    ids.set(m[1]!, set);
  }
  return ids;
}

function compressIds(ids: Map<string, Set<number>>): string {
  const parts: string[] = [];
  for (const [prefix, set] of ids) {
    const nums = [...set].sort((a, b) => a - b);
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
      parts.push(j > i ? `${prefix}-${nums[i]}..${nums[j]}` : `${prefix}-${nums[i]}`);
      i = j + 1;
    }
  }
  return parts.join(", ");
}

/** A spec Status line changed by both sides: the `Live:` lists united, ranges merged. Null if a side removed an ID. */
export function mergeStatusLine(base: string, ours: string, theirs: string): string | null {
  const [b, o, t] = [base, ours, theirs].map((l) => STATUS.exec(l));
  if (!b || !o || !t || o[1] !== t[1]) return null;
  const [bi, oi, ti] = [b[2]!, o[2]!, t[2]!].map(expandIds);
  if (!bi || !oi || !ti) return null;
  const united = new Map<string, Set<number>>();
  for (const side of [oi, ti])
    for (const [p, s] of side) united.set(p, new Set([...(united.get(p) ?? []), ...s]));
  for (const [p, s] of bi) for (const n of s) if (!oi.get(p)?.has(n) || !ti.get(p)?.has(n)) return null;
  // The rest of the line (` · **Prefix:** PIP`) comes from the side that changed it.
  const rest = o[3] !== b[3] ? o[3]! : t[3]!;
  if (o[3] !== b[3] && t[3] !== b[3] && o[3] !== t[3]) return null;
  return `${o[1]}${compressIds(united)}${rest}`;
}

/**
 * One conflict hunk, resolved: null unless neither side removed or changed a line of the merge base.
 * Then the base's lines stay, and where both sides inserted, ours come first, then theirs.
 */
export function mergeHunk(h: Hunk): string[] | null {
  if (h.base.length === 1 && h.ours.length === 1 && h.theirs.length === 1) {
    const status = mergeStatusLine(h.base[0]!, h.ours[0]!, h.theirs[0]!);
    if (status !== null) return [status];
    const edit = importEdit(h);
    if (edit) return edit;
  }
  const o = insertions(h.base, h.ours);
  const t = insertions(h.base, h.theirs);
  if (!o || !t) return null;
  const out: string[] = [];
  for (let k = 0; k <= h.base.length; k++) {
    out.push(...o[k]!, ...t[k]!);
    if (k < h.base.length) out.push(h.base[k]!);
  }
  return mergeImports(out);
}

/** A whole conflicted file, resolved: the text and the number of hunks, or null if one hunk isn't additive. */
export function resolveText(file: string): { text: string; hunks: number } | null {
  const segments = splitConflicts(file);
  if (!segments) return null;
  const lines: string[] = [];
  let hunks = 0;
  for (const s of segments) {
    if ("text" in s) lines.push(...s.text);
    else {
      const r = mergeHunk(s.hunk);
      if (!r) return null;
      hunks++;
      lines.push(...r);
    }
  }
  return hunks === 0 ? null : { text: lines.join("\n"), hunks };
}
