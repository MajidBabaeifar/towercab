// The lines an agent's comment starts with before its words (PIP-184): the hidden marker, the `🤖 <agent>
// (for <owner>)` line, or the older bracketed `[answered by … acting for the owner]` line. Readers of an
// answer (yes/no, `allow`, `/retry`) skip them, so an agent's reply is read for what it says.

const HEADER_LINE =
  /^\s*(?:<!-- towercab:agent:[A-Za-z0-9-]+ -->|🤖 .*\(for .*\)|\[answered by [^\]\n]*\])\s*$/u;

/** `text` without its leading agent header lines and the blank lines after them. */
export function stripAgentHeader(text: string): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && HEADER_LINE.test(lines[i]!)) i++;
  if (i === 0) return text;
  return lines.slice(i).join("\n").trim();
}
