// PR texts (PIP-46, PIP-48, PIP-52): the worker writes what a person reads; code adds only facts it
// owns (links, check results, the footer).

import { gitlabPath, isGitlab } from "../forge/types.ts";

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

/** PIP-222: the people part is at most this many lines and characters. */
export const PEOPLE_MAX_LINES = 5;
export const PEOPLE_MAX_CHARS = 600;

/** PIP-222: why `people` is not a good people part, or null when it is. */
export function checkPeople(people: string): string | null {
  const text = people.trim();
  if (!text) return "people part is missing";
  const lines = text.split("\n").filter((l) => l.trim()).length;
  if (lines > PEOPLE_MAX_LINES) return `people part is ${lines} lines; the limit is ${PEOPLE_MAX_LINES}`;
  if (text.length > PEOPLE_MAX_CHARS)
    return `people part is ${text.length} characters; the limit is ${PEOPLE_MAX_CHARS}`;
  if (/<\/?details/i.test(text)) return "people part contains a details block";
  if (text.includes("```")) return "people part contains a code fence";
  if (/^\S+\/\S+\.\w+$/m.test(text)) return "people part lists a file path";
  if ((text.match(/^\s*(?:[-*]|\d+\.)\s/gm) ?? []).length > 3)
    return "people part has a list of more than 3 items";
  return null;
}

/** The text with every `<details>` block (nested ones included) taken out. */
function unfolded(text: string): string {
  let out = "";
  let depth = 0;
  for (const part of text.split(/(<\/?details[^>]*>)/i)) {
    if (/^<details/i.test(part)) depth++;
    else if (/^<\/details/i.test(part)) depth = Math.max(0, depth - 1);
    else if (depth === 0) out += part;
  }
  return out;
}

/**
 * PIP-222: why a rendered text breaks the two-part shape, or null: it needs a `## For people` section
 * that passes `checkPeople`, and no agent detail (findings, files, handoff, spec IDs) outside a fold.
 */
export function checkTwoPart(text: string): string | null {
  const m = /^## For people\n\n([\s\S]*?)(?=\n## |\n<details|$)/m.exec(text);
  if (!m) return "people part is missing";
  const bad = checkPeople(m[1]!);
  if (bad) return bad;
  const rest = unfolded(text);
  const h = /^#{1,4} (Findings|Files(?: changed)?|Handoff(?: note)?)\b/im.exec(rest);
  if (h) return `agent detail (${h[1]}) is outside the folded block`;
  if (/^\*\*Spec IDs:\*\*/m.test(rest)) return "agent detail (spec IDs) is outside the folded block";
  return null;
}

/**
 * A text that fails `checkPeople`, made into one that passes: markup, list marks and line breaks
 * become plain prose, then it is cut to the character limit with `…`. A text that passes is unchanged.
 */
export function fitPeople(text: string): string {
  const t = text.trim();
  if (!checkPeople(t)) return t;
  const prose = t
    .replace(/<\/?details[^>]*>|<\/?summary[^>]*>/gi, " ")
    .replace(/```/g, " ")
    .replace(/^\s*(?:[-*]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return prose.length > PEOPLE_MAX_CHARS ? `${prose.slice(0, PEOPLE_MAX_CHARS - 1).trimEnd()}…` : prose;
}

/**
 * PIP-220: `## For people` and the people part; "" without one. A stored brief from before the limits
 * (PIP-222 checks new results only) is fitted, never refused, so a mission in flight keeps going.
 * New writers that must not post a bad part use `twoPartMd`, which refuses it.
 */
export function plainMd(brief: string | null | undefined): string {
  const b = brief?.trim() ?? "";
  return b ? `## For people\n\n${fitPeople(b)}` : "";
}

/** PIP-220: the fold for the agent part, titled "Agent context"; "" for no detail. */
export function foldMd(agent: string): string {
  const a = agent.trim();
  return a ? `<details><summary>Agent context</summary>\n\n${a}\n\n</details>` : "";
}

/**
 * PIP-220: the one shape every text for a person has: the people part first, the agent part folded
 * after it. Throws before anything is posted when the people part is missing or too long.
 */
export function twoPartMd(t: { people: string; agent?: string }): string {
  const bad = checkPeople(t.people);
  if (bad) throw new Error(bad);
  return [plainMd(t.people), foldMd(t.agent ?? "")].filter(Boolean).join("\n\n");
}

/**
 * PIP-220: a text written as one piece (a reply to the owner) as two parts: its first paragraph,
 * cut to the limits, is the people part; the rest is the agent part.
 */
export function splitTwoPart(text: string): { people: string; agent: string } {
  const [first = "", ...rest] = text.trim().split(/\n\s*\n/);
  const lines = first.split("\n").filter((l) => l.trim());
  let people = lines.slice(0, PEOPLE_MAX_LINES).join("\n");
  if (lines.length > PEOPLE_MAX_LINES) rest.unshift(lines.slice(PEOPLE_MAX_LINES).join("\n"));
  if (people.length > PEOPLE_MAX_CHARS) {
    rest.unshift(people.slice(PEOPLE_MAX_CHARS - 1));
    people = `${people.slice(0, PEOPLE_MAX_CHARS - 1).trimEnd()}…`;
  }
  // A list, code or markup in the first paragraph (an access reply naming many files) moves whole to
  // the agent part and the people part becomes its fitted prose, so the result always passes.
  if (checkPeople(people)) {
    rest.unshift(people);
    people = fitPeople(people);
  }
  return { people, agent: rest.join("\n\n") };
}

/**
 * PIP-220: the technical text, folded under "Agent context" when a people part leads the body;
 * without one (a run from before this rule) it stays open, as it was.
 */
export function detailsMd(parts: string[], brief: string | null | undefined): string[] {
  const text = parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) return [];
  return brief?.trim() ? [foldMd(text)] : [text];
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
  tests: { path: string; why: string }[];
}

/** An existing test the worker may change, and who allowed it (PIP-118). */
export interface TestChange {
  path: string;
  why: string;
  by: "plan" | "owner";
}

/** PIP-118: the code PR's plain section on existing tests changed beyond new ones; "" when none. */
export function testsChangedMd(tests: TestChange[]): string {
  if (!tests.length) return "";
  return [
    "## Tests changed beyond new ones",
    "",
    ...tests.map(
      (t) => `- \`${t.path}\`: ${t.why} (allowed by ${t.by === "plan" ? "the approved plan" : "you"})`,
    ),
  ].join("\n");
}

/**
 * The plan PR's body: the plain brief (PIP-108) and the risk (PIP-99), the approach's first
 * paragraph (folded under Details with a brief), what access it asks for, and the links.
 */
export function planBody(
  planMd: string,
  access: Access,
  l: Links,
  risk = "",
  brief = "",
  delivery: "code" | "steps" = "code",
): string {
  const approach =
    section(planMd, "Approach")
      .split(/\n\s*\n/)[0]
      ?.trim() ?? "";
  const asks = [
    ...access.domains.map((d) => `network access to ${d.domain}`),
    ...access.paths.map((p) => `writing ${p.glob}`),
    ...access.tests.map((t) => `changing the existing test ${t.path}`),
  ];
  return [
    plainMd(brief),
    risk,
    ...detailsMd([approach], brief),
    asks.length
      ? `**Access asked for:** ${asks.join(", ")}. Untick any line in the plan's Access section to refuse it before merging.`
      : "**Access asked for:** nothing beyond the defaults.",
    delivery === "steps"
      ? "**Nothing to build:** this plan is steps you do yourself. Merging this PR hands them to you, and the intent is done when you tick the last one."
      : "Merging this PR approves the plan, and the build starts.",
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
  ownerMd = "",
  delivery: "code" | "steps" = "code",
): string {
  const ids = specIds.length ? `Spec IDs: ${specIds.join(", ")}.` : "No spec change.";
  const owner = ownerMd.trim() ? `\n\n${ownerMd.trim()}` : "";
  return `# Plan: ${title}\n\nIntent ${intentId}. ${ids}\nDelivery: ${delivery}\n\n${planMd.trim()}\n\n${accessMd.trim()}${owner}\n`;
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
  /** PIP-118: existing tests granted (by the plan or the owner). */
  tests?: TestChange[];
  specIds: string[];
  links: Links;
  reviewDetails: string | null;
  /** PIP-119: outcomes only the owner can do, as a checklist. */
  ownerSteps?: { bullet: string; why: string }[];
  /** The `## Risk` section (PIP-99, `riskMd`); "" when not assessed. */
  risk?: string;
  footer: Footer;
  /** The intent's `issue:` and the PR's repo (`owner/name`), for INT-27. */
  issue?: { url: string | null; repo: string };
}

/**
 * INT-27: `Fixes #<n>` for an issue in the PR's own repo, which closes it on merge; an issue
 * anywhere else is only linked, since `Fixes` would not close it.
 * INT-67: on a GitLab project it is `Closes #<n>` for an issue of the same project, and another
 * project's issue is named by its full reference (`group/project#<n>`), which does not close it.
 */
export function issueLine(issue: { url: string | null; repo: string } | undefined): string {
  const url = issue?.url;
  if (!issue || !url) return "";
  if (isGitlab(issue.repo)) {
    const g = /^https:\/\/[^/]+\/(.+?)\/-\/issues\/(\d+)$/.exec(url);
    if (!g) return `From the issue: ${url}`;
    if (g[1]!.toLowerCase() === gitlabPath(issue.repo).toLowerCase()) return `Closes #${g[2]}`;
    return `From the issue: ${g[1]}#${g[2]}`;
  }
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
  const testsMd = testsChangedMd(b.tests ?? []);
  const stepsMd = b.ownerSteps?.length
    ? ["## For you to do", "", ...b.ownerSteps.map((s) => `- [ ] ${s.bullet} (${s.why})`)].join("\n")
    : "";
  // PIP-220: the IDs are agent detail: folded with a people part, open without.
  const ids = b.specIds.length ? `**Spec IDs:** ${b.specIds.join(", ")}` : "";
  const reviewText = b.reviewDetails?.trim() ?? "";
  // With a people part the review sits inside the one fold; without, it keeps its own.
  const review = plain ? (reviewText ? `## Review details\n\n${reviewText}` : "") : foldMd(reviewText);
  if (plain) {
    // PIP-108: what the owner decides on stays open (the risk, access beyond the plan); the worker's
    // text, the checks and the review fold under "Agent context".
    if (stepsMd) parts.push(stepsMd);
    if (unplanned) parts.push(unplanned);
    if (testsMd) parts.push(testsMd);
    parts.push(...detailsMd([...tech, review, ids], b.brief));
  } else {
    parts.push(...tech);
    if (stepsMd) parts.push(stepsMd);
    if (unplanned) parts.push(unplanned);
    if (testsMd) parts.push(testsMd);
  }
  const meta = [plain ? "" : ids, issueLine(b.issue), linkLine(b.links)].filter(Boolean).join("\n\n");
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
