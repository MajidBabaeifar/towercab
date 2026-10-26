// The **Grammar** of the repo files (REPO-1): lines, fenced blocks, `##` sections and bullets.
// Errors read `<where>: <what>`; the file parsers add `<file>: `.

/** A list item: up to 3 spaces, `-`, `*`, `+` or 1-9 digits and `.` or `)`, then a space or tab. */
const BULLET = /^ {0,3}(?:[-*+]|[0-9]{1,9}[.)])[ \t](.*)$/;

/** UTF-8 text → lines: a leading BOM dropped, split on `\n`, a trailing `\r` dropped. */
export function lines(text: string): string[] {
  const t = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return t.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** A fenced block. */
export interface Fence {
  kind: "fence";
  /** 1-based line of the opening fence. */
  line: number;
  /** The rest of the opening line, trimmed. */
  name: string;
  /** Its lines trimmed, minus blank lines and lines starting `#`. */
  body: string[];
  /** Every line from the opening to the closing fence, as written. */
  raw: string[];
}

/** A line outside fences (1-based number), or a fenced block. */
export type Item = { kind: "line"; n: number; text: string } | Fence;

/**
 * Lines (the first being line `first`) → items. A fence opens on a line starting (after spaces)
 * with 3 or more backticks or tildes and closes on the next line that trims to at least as many of
 * the same character; none → `line <n>: unclosed ```<name> block`.
 */
export function items(ls: string[], first = 1): Item[] {
  const out: Item[] = [];
  let i = 0;
  while (i < ls.length) {
    const n = first + i;
    const line = ls[i]!;
    const open = fenceOpen(line);
    if (!open) {
      out.push({ kind: "line", n, text: line });
      i++;
      continue;
    }
    const { mark, count, name } = open;
    let close = -1;
    for (let j = i + 1; j < ls.length; j++) {
      const t = ls[j]!.trim();
      if (t.length >= count && [...t].every((c) => c === mark)) {
        close = j;
        break;
      }
    }
    if (close < 0) throw new Error(`line ${n}: unclosed \`\`\`${name} block`);
    out.push({
      kind: "fence",
      line: n,
      name,
      body: ls
        .slice(i + 1, close)
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#")),
      raw: ls.slice(i, close + 1),
    });
    i = close + 1;
  }
  return out;
}

function fenceOpen(line: string): { mark: string; count: number; name: string } | null {
  const rest = line.replace(/^ +/, "");
  const mark = rest[0];
  if (mark !== "`" && mark !== "~") return null;
  let count = 0;
  while (rest[count] === mark) count++;
  const name = rest.slice(count).trim();
  if (count < 3 || (mark === "`" && name.includes("`"))) return null;
  return { mark, count, name };
}

/** The title of a column-0 `## <title>` line, trimmed, closing `#`s (after a space) dropped. */
function sectionTitle(line: string): string | null {
  if (!line.startsWith("## ")) return null;
  const title = line.slice(3).trim();
  const open = title.replace(/#+$/, "");
  if (open.length < title.length && (open === "" || /[ \t]$/.test(open))) return open.trim();
  return title;
}

function isHeading(line: string): boolean {
  return line.startsWith("# ") || line.startsWith("## ");
}

/**
 * Per `known` title (case-insensitive), the items of its section: after the heading, up to the next
 * `# ` or `## ` line outside fences. A known title twice → `line <n>: two ## <title> sections`.
 */
export function sections(its: Item[], known: string[]): (Item[] | null)[] {
  const found: (Item[] | null)[] = known.map(() => null);
  let i = 0;
  while (i < its.length) {
    const it = its[i]!;
    const title = it.kind === "line" ? sectionTitle(it.text) : null;
    if (it.kind !== "line" || title === null) {
      i++;
      continue;
    }
    const start = i + 1;
    let end = its.length;
    for (let j = start; j < its.length; j++) {
      const x = its[j]!;
      if (x.kind === "line" && isHeading(x.text)) {
        end = j;
        break;
      }
    }
    const k = known.findIndex((t) => t.toLowerCase() === title.toLowerCase());
    if (k >= 0) {
      if (found[k]) throw new Error(`line ${it.n}: two ## ${known[k]} sections`);
      found[k] = its.slice(start, end);
    }
    i = end;
  }
  return found;
}

/**
 * Per name, its block with a non-empty body, if any. Two such blocks of one name →
 * `line <n>: two ```<name> blocks`.
 */
export function fences(its: Item[], names: string[]): (Fence | null)[] {
  const found: (Fence | null)[] = names.map(() => null);
  for (const it of its) {
    if (it.kind !== "fence") continue;
    const k = names.indexOf(it.name);
    if (k < 0 || it.body.length === 0) continue;
    if (found[k]) throw new Error(`line ${it.line}: two \`\`\`${it.name} blocks`);
    found[k] = it;
  }
  return found;
}

/**
 * Bullets outside fences (nesting flattened), each continued by the indented non-blank lines after
 * it that aren't items; lines trimmed, joined with one space.
 */
export function bullets(its: Item[]): string[] {
  const out: string[] = [];
  let open = false;
  for (const it of its) {
    if (it.kind !== "line") {
      open = false;
      continue;
    }
    const m = BULLET.exec(it.text);
    if (m) {
      out.push(m[1]!.trim());
      open = true;
    } else if (open && out.length && /^[ \t]/.test(it.text) && it.text.trim() !== "") {
      const last = out.length - 1;
      out[last] = out[last] ? `${out[last]} ${it.text.trim()}` : it.text.trim();
    } else {
      open = false;
    }
  }
  return out;
}

/** The items' lines as written, joined with `\n`. */
export function text(its: Item[]): string {
  return its.flatMap((it) => (it.kind === "line" ? [it.text] : it.raw)).join("\n");
}
