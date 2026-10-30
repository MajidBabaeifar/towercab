// PR texts (PIP-46, PIP-48, PIP-52): the worker writes what a person reads; code adds only facts it
// owns (links, check results, the footer).

export interface Footer {
  intentUrl: string | null;
  costUsd: number;
  secs: number;
}

export function footer(f: Footer): string {
  const h = Math.floor(f.secs / 3600);
  const m = Math.floor((f.secs % 3600) / 60);
  const intent = f.intentUrl ? `[intent](${f.intentUrl})` : "intent";
  return `<sub>Built by Towercab · ${intent} · $${f.costUsd.toFixed(2)} · ${h}h${String(m).padStart(2, "0")}m</sub>`;
}

export interface Links {
  intentUrl: string | null;
  specPrUrl: string | null;
  planPrUrl: string | null;
}

/** The "this change's other PRs" line (PIP-52). */
export function linkLine(l: Links): string {
  const parts: string[] = [];
  if (l.intentUrl) parts.push(`[intent](${l.intentUrl})`);
  if (l.specPrUrl) parts.push(`[spec PR](${l.specPrUrl})`);
  if (l.planPrUrl) parts.push(`[plan PR](${l.planPrUrl})`);
  return parts.length ? `Part of this change: ${parts.join(" · ")}.` : "";
}

/** PIP-108: the `## In plain words` section every PR body opens with; no brief → "". */
export function plainMd(brief: string | null | undefined): string {
  const b = brief?.trim() ?? "";
  return b ? `## In plain words\n\n${b}` : "";
}

/**
 * PIP-108: the technical text, folded under "Details" when a plain brief leads the body; without a
 * brief (a run from before briefs) it stays open, as it was.
 */
export function detailsMd(parts: string[], brief: string | null | undefined): string[] {
  const text = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) return [];
  return brief?.trim() ? [`<details><summary>Details</summary>\n\n${text}\n\n</details>`] : [text];
}

/**
 * The spec PR's body: the plain brief (PIP-108), the open points and the risk (PIP-99) beside it,
 * then the worker's technical text and the spec IDs (folded), and the links.
 */
export function specBody(
  workerText: string,
  specIds: string[],
  l: Links,
  extra: string[] = [],
  brief = "",
): string {
  return [
    plainMd(brief),
    ...extra,
    ...detailsMd([workerText, specIds.length ? `**Spec IDs:** ${specIds.join(", ")}` : ""], brief),
    linkLine(l),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface Access {
  domains: { domain: string; why: string }[];
  paths: { glob: string; why: string }[];
}

/**
 * The plan PR's body: the plain brief (PIP-108) and the risk (PIP-99), the approach's first
 * paragraph (folded under Details with a brief), what access it asks for, and the links.
 */
export function planBody(planMd: string, access: Access, l: Links, risk = "", brief = ""): string {
  const approach =
    section(planMd, "Approach")
      .split(/\n\s*\n/)[0]
      ?.trim() ?? "";
  const asks = [
    ...access.domains.map((d) => `network access to ${d.domain}`),
    ...access.paths.map((p) => `writing ${p.glob}`),
  ];
  return [
    plainMd(brief),
    risk,
    ...detailsMd([approach], brief),
    asks.length
      ? `**Access asked for:** ${asks.join(", ")}. Untick any line in the plan's Access section to refuse it before merging.`
      : "**Access asked for:** nothing beyond the defaults.",
    "Merging this PR approves the plan, and the build starts.",
    linkLine(l),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** `plan.md` (PIP-46): title, IDs, the worker's sections, then the access checklist. */
export function planFile(
  title: string,
  intentId: string,
  specIds: string[],
  planMd: string,
  accessMd: string,
): string {
  const ids = specIds.length ? `Spec IDs: ${specIds.join(", ")}.` : "No spec change.";
  return `# Plan: ${title}\n\nIntent ${intentId}. ${ids}\n\n${planMd.trim()}\n\n${accessMd.trim()}\n`;
}

export interface Checks {
  verify: string;
  proof: string;
  ci: string;
  review: string;
}

export interface CodeBody {
  /** The worker's Markdown (What this does / Why / What to check / Changes), or null. */
  worker: string | null;
  /** PIP-108: the worker's plain brief; "" or absent → no `## In plain words`. */
  brief?: string;
  intentTitle: string;
  intentProblem: string | null;
  checks: Checks | null;
  unplanned: { what: string; why: string }[];
  specIds: string[];
  links: Links;
  reviewDetails: string | null;
  /** The `## Risk` section (PIP-99, `riskMd`); "" when not assessed. */
  risk?: string;
  footer: Footer;
  /** The intent's `issue:` and the PR's repo (`owner/name`), for INT-27. */
  issue?: { url: string | null; repo: string };
}

/**
 * INT-27: `Fixes #<n>` for an issue in the PR's own repo, which closes it on merge; an issue
 * anywhere else is only linked, since `Fixes` would not close it.
 */
export function issueLine(issue: { url: string | null; repo: string } | undefined): string {
  const url = issue?.url;
  if (!issue || !url) return "";
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url);
  if (m && m[1]!.toLowerCase() === issue.repo.toLowerCase()) return `Fixes #${m[2]}`;
  return `From the issue: ${url}`;
}

/**
 * The code PR's body (PIP-48): the plain brief and the risk first (PIP-108), access beyond the plan,
 * then the technical text (folded under Details with a brief), the IDs and links, the footer.
 */
export function codeBody(b: CodeBody): string {
  const parts: string[] = [];
  const plain = plainMd(b.brief);
  if (plain) parts.push(plain);
  if (b.risk) parts.push(b.risk);
  const tech: string[] = [];
  if (b.worker?.trim()) tech.push(b.worker.trim());
  else {
    tech.push(`## What this does\n\n${b.intentTitle}.`);
    if (b.intentProblem) tech.push(`## Why\n\n${b.intentProblem.trim()}`);
  }
  if (b.checks) {
    tech.push(
      [
        "## Checks",
        "",
        `- Local checks: ${b.checks.verify}`,
        `- Test proof: ${b.checks.proof}`,
        `- CI: ${b.checks.ci}`,
        `- Review: ${b.checks.review}`,
      ].join("\n"),
    );
  }
  const unplanned = b.unplanned.length
    ? ["## Access beyond the plan", "", ...b.unplanned.map((u) => `- ${u.what}: ${u.why}`)].join("\n")
    : "";
  const review = b.reviewDetails?.trim()
    ? `<details><summary>Review details</summary>\n\n${b.reviewDetails.trim()}\n\n</details>`
    : "";
  if (plain) {
    // PIP-108: what the owner decides on stays open (the risk, access beyond the plan); the worker's
    // text, the checks and the review fold under Details.
    if (unplanned) parts.push(unplanned);
    parts.push(...detailsMd([...tech, review], b.brief));
  } else {
    parts.push(...tech);
    if (unplanned) parts.push(unplanned);
  }
  const meta = [
    b.specIds.length ? `**Spec IDs:** ${b.specIds.join(", ")}` : "",
    issueLine(b.issue),
    linkLine(b.links),
  ]
    .filter(Boolean)
    .join("\n\n");
  if (meta) parts.push(meta);
  if (!plain && review) parts.push(review);
  parts.push(footer(b.footer));
  return parts.join("\n\n");
}

/** The body of `## <title>` in a Markdown text, trimmed ("" when absent). */
export function section(md: string, title: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${title.toLowerCase()}`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}
