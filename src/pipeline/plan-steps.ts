// PIP-216: the numbered steps of a plan, and how many of them a build run says it built.

/** The numbered items under `## Steps` of `plan.md`, each as one line of text, in order. */
export function planSteps(md: string): string[] {
  const out: string[] = [];
  let inSteps = false;
  for (const line of md.split("\n")) {
    if (/^##\s/.test(line)) {
      inSteps = /^##\s+Steps\s*$/i.test(line);
      continue;
    }
    if (!inSteps) continue;
    const item = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
    if (item) out.push(item[1]!.trim());
    // A continuation line belongs to the item above it.
    else if (out.length && /^\s{2,}\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

/**
 * The worker's `steps_done` as the count Towercab records: null means all of `total`, and the count
 * never goes down or past the plan (a worker may over- or under-report).
 */
export function clampSteps(reported: number | null, previous: number, total: number): number {
  const n = reported === null ? total : reported;
  return Math.min(total, Math.max(previous, n));
}
