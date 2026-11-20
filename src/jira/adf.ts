// JIRA-6: a ticket's description arrives as Atlassian document format (JSON), as plain text, or as null.
// The scoring run reads plain text: paragraphs and list items on their own lines, links as their text and
// URL, code blocks kept; images, media and a mention's id are dropped.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The node types whose content is never shown. */
const SKIPPED = new Set(["media", "mediaSingle", "mediaGroup", "mediaInline", "emoji", "extension"]);

function inline(n: Obj): string {
  if (n.type === "hardBreak") return "\n";
  if (n.type === "mention") return isObj(n.attrs) && typeof n.attrs.text === "string" ? n.attrs.text : "";
  if (n.type === "inlineCard") return isObj(n.attrs) && typeof n.attrs.url === "string" ? n.attrs.url : "";
  const text = typeof n.text === "string" ? n.text : "";
  const link = Array.isArray(n.marks)
    ? n.marks.find((m) => isObj(m) && m.type === "link" && isObj(m.attrs) && typeof m.attrs.href === "string")
    : undefined;
  const href = isObj(link) && isObj(link.attrs) ? String(link.attrs.href) : "";
  return href && text !== href ? `${text} (${href})` : text;
}

function children(n: Obj): Obj[] {
  return Array.isArray(n.content) ? n.content.filter(isObj) : [];
}

/** The text of the inline children of a block. */
function line(n: Obj): string {
  return children(n)
    .map((c) => (SKIPPED.has(String(c.type)) ? "" : children(c).length && !c.text ? line(c) : inline(c)))
    .join("");
}

function block(n: Obj, out: string[], depth: number): void {
  const type = String(n.type);
  if (SKIPPED.has(type)) return;
  switch (type) {
    case "bulletList":
    case "orderedList":
      children(n).forEach((item, i) => {
        const marker = type === "bulletList" ? "-" : `${i + 1}.`;
        const kids = children(item);
        const first = kids.find((k) => k.type === "paragraph");
        out.push(`${"  ".repeat(depth)}${marker} ${first ? line(first) : ""}`);
        for (const k of kids) if (k !== first) block(k, out, depth + 1);
      });
      return;
    case "codeBlock":
      out.push("```", line(n), "```");
      return;
    case "paragraph":
    case "heading":
      out.push(line(n));
      return;
    default: {
      const kids = children(n);
      // A block with blocks inside (a quote, a panel, a table cell) is its blocks; one with text is a line.
      if (
        kids.some(
          (k) => k.type && !["text", "hardBreak", "mention", "inlineCard", "emoji"].includes(String(k.type)),
        )
      )
        for (const k of kids) block(k, out, depth);
      else if (kids.length) out.push(line(n));
    }
  }
}

/** The description as plain text; an unreadable one is empty. */
export function adfToText(doc: unknown): string {
  if (doc === null || doc === undefined) return "";
  if (typeof doc === "string") return doc.trim();
  if (!isObj(doc)) return "";
  const out: string[] = [];
  for (const n of children(doc)) block(n, out, 0);
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
