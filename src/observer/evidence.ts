// UI-243: the evidence and the expected gain an observer proposal carries (OBV-5), read back from the
// intent file's sections so the page can show them above the rest of the text.

export interface ObserverNote {
  /** Markdown: the list of links, each with what it shows. */
  evidence: string;
  /** Markdown: the expected gain. */
  gain: string;
}

/** The text under `### <heading>` in `text`, up to the next heading, trimmed; "" when absent. */
function under(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === `### ${heading}`);
  if (at < 0) return "";
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,3} /.test(l)) break;
    out.push(l);
  }
  return out.join("\n").trim();
}

/** The note of an intent's sections, or null when it has neither part. */
export function observerNote(sections: Map<string, string>): ObserverNote | null {
  const evidence = under(sections.get("Problem") ?? "", "Evidence");
  const gain = under(sections.get("Proposed outcome") ?? "", "Expected gain");
  return evidence || gain ? { evidence, gain } : null;
}
