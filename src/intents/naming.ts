// Intent names and commit subjects written by agents (INT-33, INT-36, PIP-111): one plain line that
// can't open a heading, a list, an HTML comment or a code span, or mention anyone on GitHub.

/** The longest title an agent's text becomes (INT-36). */
export const TITLE_MAX = 100;
/** The longest commit subject (PIP-111). */
export const SUBJECT_MAX = 60;

/**
 * Model text as one plain line: printable characters only, no HTML comment, no `<`, `>` or backticks, no `@` before a
 * name, no leading `#`, `-`, `*` or `@`, no trailing period; cut at a word boundary to `max`.
 */
export function plainLine(s: string, max: number): string {
  let l = s
    .replace(/[\p{C}]/gu, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[<>`]/g, "")
    .replace(/@(?=[\w-])/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (;;) {
    const next = l.replace(/^[#\-*@\s]+/, "").replace(/[\s.]+$/, "");
    if (next === l) break;
    l = next;
  }
  if (l.length <= max) return l;
  const cut = l.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : l.slice(0, max)).replace(/[\s.,;:-]+$/, "");
}

/**
 * INT-36: why `title` doesn't follow the naming rule (INT-33) closely enough to replace one, or null
 * when it does: about 6 to 14 words, so fewer than 4 or more than 20 is refused.
 */
export function titleProblem(title: string): string | null {
  const words = title.split(" ").filter(Boolean).length;
  if (words < 4) return `"${title}" has ${words} word${words === 1 ? "" : "s"}, fewer than 4`;
  if (words > 20) return `it has ${words} words, more than 20`;
  return null;
}
