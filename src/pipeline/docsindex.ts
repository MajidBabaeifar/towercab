// The README's docs index (PIP-172): the one part of README.md a design may change, and only to link
// a spec file it adds.

/** Where the first Markdown table under `## Docs` sits in `lines`: `[start, end)`, or null. */
function tableOf(lines: string[]): [number, number] | null {
  const h = lines.findIndex((l) => /^##\s+Docs\s*$/.test(l));
  if (h < 0) return null;
  let start = h + 1;
  while (start < lines.length && lines[start]!.trim() === "") start++;
  if (!lines[start]?.startsWith("|")) return null;
  let end = start;
  while (end < lines.length && lines[end]!.startsWith("|")) end++;
  return [start, end];
}

/**
 * True when `edited` is `base` with rows added to the docs table, and nothing else changed: the text
 * before the table, its header and separator, every existing row (in order) and the text after it are
 * byte-identical.
 */
export function docsTableOnly(base: string, edited: string): boolean {
  const a = base.split("\n");
  const b = edited.split("\n");
  const ta = tableOf(a);
  const tb = tableOf(b);
  if (!ta || !tb) return false;
  const [sa, ea] = ta;
  const [sb, eb] = tb;
  if (sa !== sb) return false;
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((l, i) => l === y[i]);
  if (!same(a.slice(0, sa + 2), b.slice(0, sb + 2))) return false;
  if (!same(a.slice(ea), b.slice(eb))) return false;
  // The existing rows stay, in order; anything else in the table is an added row.
  const rows = b.slice(sb + 2, eb);
  let at = 0;
  for (const r of rows) if (r === a[sa + 2 + at] && sa + 2 + at < ea) at++;
  return at === ea - (sa + 2);
}
