// A small, safe Markdown renderer for text Claude wrote for a person (PIP-40): paragraphs, headings,
// lists, code, emphasis and http(s) links, built as elements (never innerHTML).

import type { ComponentChildren, JSX } from "preact";

function inline(text: string, key = 0): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let n = key;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={n++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={n++}>{inline(t.slice(2, -2), n * 100)}</strong>);
    else if (m[3]) out.push(<em key={n++}>{t.slice(1, -1)}</em>);
    else if (m[4]) {
      const label = t.slice(1, t.indexOf("]("));
      out.push(
        <a key={n++} href={m[5]} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    } else if (m[6]) {
      out.push(
        <a key={n++} href={t} target="_blank" rel="noopener noreferrer">
          {t}
        </a>,
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string };

export function blocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]!);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (m) items.push(m[2]!);
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) items[items.length - 1] += ` ${l.trim()}`;
        else break;
        i++;
      }
      out.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }
    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith(">")) body.push(lines[i++]!.replace(/^>\s?/, ""));
      out.push({ kind: "quote", text: body.join(" ") });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,6}\s|\s*```|\s*([-*+]|\d+[.)])\s+|>)/.test(lines[i]!)
    ) {
      para.push(lines[i++]!.trim());
    }
    out.push({ kind: "p", text: para.join(" ") });
  }
  return out;
}

export function Markdown({ text, class: cls }: { text: string; class?: string }): JSX.Element {
  return (
    <div class={`md${cls ? ` ${cls}` : ""}`}>
      {blocks(text).map((b, n) => {
        switch (b.kind) {
          case "p":
            return <p key={n}>{inline(b.text)}</p>;
          case "h":
            return b.level <= 2 ? <h4 key={n}>{inline(b.text)}</h4> : <h5 key={n}>{inline(b.text)}</h5>;
          case "ul":
            return (
              <ul key={n}>
                {b.items.map((t, k) => (
                  <li key={k}>
                    {inline(t.replace(/^\[([ xX])\]\s+/, (_, x: string) => (x === " " ? "☐ " : "☑ ")))}
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={n}>
                {b.items.map((t, k) => (
                  <li key={k}>{inline(t)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={n}>
                <code>{b.text}</code>
              </pre>
            );
          case "quote":
            return <blockquote key={n}>{inline(b.text)}</blockquote>;
          default:
            return null;
        }
      })}
    </div>
  );
}
