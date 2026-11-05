// INT-43: the per-repo parts of a multi-repo plan, checked and put in landing order. Pure.

/** One entry of the plan result's `repos`: what changes in a repo and which parts land before it. */
export interface RepoPart {
  repo: string;
  /** Plain words; empty = this repo has no change after all (dropped). */
  change: string;
  /** Repos whose parts land before this one. */
  waits_on: string[];
  /** Why this part, landed with only the parts before it, works live without the later ones. */
  safe_alone: string;
}

export interface CheckedParts {
  /** Parts with a change, in landing order (a part after every part it waits on; ties in the plan's order). */
  parts: RepoPart[];
  /** Repos of the intent the plan gives no change to. */
  dropped: string[];
}

type Checked = { ok: true; value: CheckedParts } | { ok: false; why: string };

const refuse = (why: string): Checked => ({ ok: false, why });

/**
 * The plan's parts for an intent with lead `lead` and other repos `others`, or why they are refused. A
 * single-repo intent (`others` empty) takes no parts. The lead always has a part.
 */
export function checkParts(lead: string, others: string[], given: RepoPart[]): Checked {
  if (others.length === 0) return { ok: true, value: { parts: [], dropped: [] } };
  const named = new Set([lead, ...others]);
  const seen = new Set<string>();
  for (const p of given) {
    if (!named.has(p.repo)) return refuse(`the plan has a part for ${p.repo}, which the intent doesn't name`);
    if (seen.has(p.repo)) return refuse(`the plan has two parts for ${p.repo}`);
    seen.add(p.repo);
  }
  for (const r of named) {
    if (!seen.has(r)) return refuse(`the plan has no part for ${r}: give every repo of the intent an entry`);
  }
  const withChange = given.filter((p) => p.change.trim() !== "");
  const dropped = given.filter((p) => p.change.trim() === "").map((p) => p.repo);
  if (dropped.includes(lead))
    return refuse(`the lead repo ${lead} always has a part: say what changes there`);
  const live = new Set(withChange.map((p) => p.repo));
  for (const p of withChange) {
    for (const w of p.waits_on) {
      if (w === p.repo) return refuse(`the part for ${p.repo} waits on itself`);
      if (!named.has(w)) return refuse(`the part for ${p.repo} waits on ${w}, which the intent doesn't name`);
    }
  }
  // Waiting on a dropped repo is no wait.
  const waits = new Map(withChange.map((p) => [p.repo, p.waits_on.filter((w) => live.has(w))]));
  const ordered: RepoPart[] = [];
  const done = new Set<string>();
  while (ordered.length < withChange.length) {
    const next = withChange.find((p) => !done.has(p.repo) && waits.get(p.repo)!.every((w) => done.has(w)));
    if (!next) {
      const stuck = withChange.filter((p) => !done.has(p.repo)).map((p) => p.repo);
      return refuse(`the order of the parts has a cycle (${stuck.join(", ")}): no part can land first`);
    }
    done.add(next.repo);
    ordered.push(next);
  }
  const unsafe = ordered.find((p) => p.safe_alone.trim() === "");
  if (unsafe) return refuse(`say why the part for ${unsafe.repo} works live without the parts after it`);
  return { ok: true, value: { parts: ordered, dropped } };
}

/** The plan's `## Repos` section for the checked parts (the order is the landing order). */
export function reposMd(checked: CheckedParts): string {
  if (checked.parts.length === 0) return "";
  const lines = ["## Repos", "", "Parts land in this order.", ""];
  for (const p of checked.parts) {
    const wait = p.waits_on.filter((w) => checked.parts.some((x) => x.repo === w));
    lines.push(`### ${p.repo}`, "", p.change.trim(), "");
    lines.push(wait.length ? `Lands after: ${wait.join(", ")}.` : "Lands first.");
    lines.push(`Works without the later parts: ${p.safe_alone.trim()}`, "");
  }
  for (const r of checked.dropped) lines.push(`No change in ${r}, so it has no part.`, "");
  return lines.join("\n").trimEnd();
}

/** The plan text with its `## Repos` section replaced by `section` (placed before `## Files that change`). */
export function withRepos(md: string, section: string): string {
  const without = md.replace(/^## Repos\n[\s\S]*?(?=^## |(?![\s\S]))/m, "").trimEnd();
  if (!section) return md.includes("## Repos") ? `${without}\n` : md;
  const at = without.search(/^## Files that change/m);
  if (at < 0) return `${without}\n\n${section}\n`;
  return `${without.slice(0, at)}${section}\n\n${without.slice(at)}\n`;
}
