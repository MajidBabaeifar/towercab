// Requirement IDs (PIP-130, PIP-131, PIP-132): which IDs a spec adds, which are taken, the next free
// ones, who yields on a clash, and the renumbering of text. Pure: git, GitHub and files are the callers'.

/** `PIP-130`, `PIP-130..132` or `PIP-130..PIP-132`, as a whole word. */
const RANGE = /(?<![A-Za-z0-9_-])([A-Z]+)-(\d+)(?:\.\.(?:\1-)?(\d+))?(?![A-Za-z0-9_])/g;

/** A range wider than this is left alone (a typo, not a list of requirements). */
const MAX_SPAN = 1000;

/** The IDs in `text` (`spec IDs: PIP-130..132, UI-4`), ranges expanded, each once, in order. */
export function parseIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(RANGE)) {
    const lo = Number(m[2]);
    const hi = m[3] === undefined ? lo : Number(m[3]);
    if (hi < lo || hi - lo > MAX_SPAN) out.add(`${m[1]}-${m[2]}`);
    else for (let n = lo; n <= hi; n++) out.add(`${m[1]}-${n}`);
  }
  return [...out];
}

/** IDs as the shortest list: consecutive numbers of one prefix become a range. */
export function formatIds(ids: string[]): string {
  const runs: { prefix: string; lo: number; hi: number }[] = [];
  for (const id of ids) {
    const [prefix, n] = split(id);
    const last = runs.at(-1);
    if (last && last.prefix === prefix && last.hi + 1 === n) last.hi = n;
    else runs.push({ prefix, lo: n, hi: n });
  }
  return runs.map((r) => (r.lo === r.hi ? `${r.prefix}-${r.lo}` : `${r.prefix}-${r.lo}..${r.hi}`)).join(", ");
}

function split(id: string): [string, number] {
  const i = id.lastIndexOf("-");
  return [id.slice(0, i), Number(id.slice(i + 1))];
}

/** The IDs of the `### <ID> ·` headings of a spec file, in order (an ID twice is listed twice). */
export function headingIds(text: string): string[] {
  return [...text.matchAll(/^### ([A-Z]+-\d+)(?=\s|$)/gm)].map((m) => m[1]!);
}

/** The IDs a diff adds as headings (`+### <ID> ·` lines). */
export function addedIds(diff: string): string[] {
  return [...new Set([...diff.matchAll(/^\+### ([A-Z]+-\d+)(?=\s|$)/gm)].map((m) => m[1]!))];
}

/**
 * PIP-202: whether `branch` is a spec PR head of intent `intentId`: `towercab/<id>-…-spec`, where the
 * segment right after the prefix is not a bare number (that is a sibling intent, `261105-2152-2`).
 */
export function ownSpecBranch(intentId: string, branch: string): boolean {
  const prefix = `towercab/${intentId}-`;
  if (!branch.startsWith(prefix) || !branch.endsWith("-spec")) return false;
  const first = branch.slice(prefix.length).split("-")[0]!;
  return first !== "" && !/^\d+$/.test(first);
}

/** PIP-202: the IDs on lines of an intent that say they are "already written". */
export function namedAsWritten(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n"))
    if (/already written/i.test(line)) for (const id of parseIds(line)) out.add(id);
  return [...out];
}

/** The next `count` free numbers of `prefix`, after the highest taken one. */
export function nextFree(prefix: string, taken: Iterable<string>, count: number): string[] {
  let top = 0;
  for (const id of taken) {
    const [p, n] = split(id);
    if (p === prefix && n > top) top = n;
  }
  return Array.from({ length: count }, (_, i) => `${prefix}-${top + 1 + i}`);
}

/**
 * Each of `ids`, in order, to the next free number after the highest taken one of its prefix. Used for
 * a whole reserved range (the result is the next block of the same length) and for single clashing rows.
 */
export function moveIds(ids: string[], taken: Iterable<string>): Map<string, string> {
  const used = new Set(taken);
  const map = new Map<string, string>();
  for (const id of ids) {
    const [to] = nextFree(split(id)[0], used, 1);
    map.set(id, to!);
    used.add(to!);
  }
  return map;
}

/** `text` with every ID in `map` replaced, whole words only (`PIP-13` never touches `PIP-130`), ranges included. */
export function applyMap(text: string, map: ReadonlyMap<string, string>): string {
  if (!map.size) return text;
  return text.replace(RANGE, (whole, prefix: string, lo: string, hi?: string) => {
    if (hi === undefined) return map.get(`${prefix}-${lo}`) ?? whole;
    if (Number(hi) < Number(lo) || Number(hi) - Number(lo) > MAX_SPAN) return whole;
    const ids = parseIds(whole);
    return ids.some((i) => map.has(i)) ? formatIds(ids.map((i) => map.get(i) ?? i)) : whole;
  });
}

/** What decides who yields: the PR's number (null: not opened yet) and whether it is approved. */
export interface Contender {
  number: number | null;
  approved: boolean;
}

/** PIP-130: whether `me` gives up a clashing ID: the unapproved one; else (both or neither) the later one. */
export function yields(me: Contender, other: Contender): boolean {
  if (me.approved !== other.approved) return !me.approved;
  if (me.number === null) return true;
  if (other.number === null) return false;
  return me.number > other.number;
}

/** What `idProblems` compares. */
export interface IdFacts {
  /** Every heading of the checked tree, with its file (an ID in two headings is listed twice). */
  head: { id: string; file: string }[];
  /** IDs at the merge base with the base branch. */
  mergeBase: Set<string>;
  /** IDs on the base branch's tip. */
  base: Set<string>;
  /** The IDs other open PRs add; null when there is no list. */
  open: { number: number; ids: string[] }[] | null;
}

/** PIP-132: why the tree's IDs are not safe to merge; empty when they are. */
export function idProblems(f: IdFacts): string[] {
  const out: string[] = [];
  const files = new Map<string, string[]>();
  for (const h of f.head) files.set(h.id, [...(files.get(h.id) ?? []), h.file]);
  for (const [id, where] of files) {
    if (where.length > 1) out.push(`${id}: ${where.length} headings carry this ID (${where.join(", ")})`);
    if (f.mergeBase.has(id)) continue;
    if (f.base.has(id) && where.length === 1)
      out.push(`${id} (${where[0]}): added here, but the base branch already has this ID`);
    for (const p of f.open ?? [])
      if (p.ids.includes(id)) out.push(`${id} (${where[0]}): also added by open pull request #${p.number}`);
  }
  return out;
}
