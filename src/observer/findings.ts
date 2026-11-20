// What Towercab does with the observer's answer before anything reaches GitHub (OBV-4..7): drop what
// can't be checked, fold what overlaps an existing intent into a comment or the report, and let only
// the best few through. The agent's word is never enough: every id it cites must be in its bundle.

import type { Config } from "../config.ts";
import type { ProposedPr } from "../github/proposed.ts";
import { plainLine, TITLE_MAX, titleProblem } from "../intents/naming.ts";
import type { Listing } from "../intents/types.ts";
import type { ObserverFinding } from "../pipeline/schemas.ts";
import type { ProposalRow } from "./store.ts";

/** Autonomy never above 4 for an intent that isn't the owner's (OBV-4, AUT-13). */
export const MAX_A = 4;

export interface Target {
  /** The repo (`owner/name`) and number of the pull request to comment on. */
  repo: string;
  number: number;
}

export interface Judged {
  /** Findings to propose, best first. */
  propose: ObserverFinding[];
  /** Evidence to add to an existing pull request, once per target. */
  comments: { target: Target; finding: ObserverFinding }[];
  /** Overlaps with work already going or done: report only (OBV-6). */
  seen: { title: string; links: string[] }[];
  /** Good findings that did not fit the weekly limit (OBV-7). */
  held: ObserverFinding[];
  dropped: { title: string; why: string }[];
}

export interface JudgeInput {
  config: Config;
  /** Ids the agent was given (OBV-3). */
  ids: Set<string>;
  listing: Listing | null;
  proposed: ProposedPr[];
  /** `owner/name` of the intents repo. */
  intentsRepo: string | null;
  /** Proposals in the last 7 days, closed ones too (OBV-7). */
  recent: ProposalRow[];
  /** Every earlier proposal still kept (90 days). */
  earlier: ProposalRow[];
}

export const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const PR_URL = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/;

function prOf(url: string | null): Target | null {
  const m = url ? PR_URL.exec(url) : null;
  return m ? { repo: m[1]!, number: Number(m[2]) } : null;
}

interface Known {
  id: string;
  title: string;
  /** Where evidence can be added: a pull request, or null. */
  target: Target | null;
  /** A link to show in the report. */
  link: string;
  /** `proposal`, or an intent not yet building (`early`) or going or done (`late`). */
  kind: "proposal" | "early" | "late";
  aliases: string[];
}

function known(i: JudgeInput): Known[] {
  const out: Known[] = [];
  const repo = i.intentsRepo;
  for (const p of i.proposed) {
    const id = repo ? `${repo}#${p.number}` : `#${p.number}`;
    out.push({
      id,
      title: p.intent?.title ?? p.title,
      target: repo ? { repo, number: p.number } : null,
      link: p.url,
      kind: "proposal",
      aliases: [String(p.number), id, `#${p.number}`],
    });
  }
  if (i.listing) {
    for (const x of i.listing.open) {
      const stage = x.stage;
      const early = stage === null || stage === "spec" || stage === "plan";
      const pr = stage === "spec" ? prOf(x.specPr) : stage === "plan" ? prOf(x.planPr) : null;
      out.push({
        id: x.id,
        title: x.title,
        target: early ? pr : null,
        link: x.id,
        kind: early && pr ? "early" : "late",
        aliases: [x.id],
      });
    }
    for (const x of i.listing.done) {
      out.push({ id: x.id, title: x.title, target: null, link: x.id, kind: "late", aliases: [x.id] });
    }
  }
  return out;
}

/** OBV-4..7 over one run's findings. `a` is clamped, titles cleaned, evidence deduplicated. */
export function judge(findings: ObserverFinding[], i: JudgeInput): Judged {
  const res: Judged = { propose: [], comments: [], seen: [], held: [], dropped: [] };
  const all = known(i);
  const repos = new Set(i.config.repos.keys());
  const commented = new Set<string>();
  const queue: ObserverFinding[] = [];
  const proposedNow = new Set<string>();

  for (const raw of findings) {
    const title = plainLine(raw.title, TITLE_MAX);
    const drop = (why: string) => res.dropped.push({ title: title || raw.title.slice(0, 60), why });
    const bad = titleProblem(title);
    if (bad) {
      drop(`title: ${bad}`);
      continue;
    }
    const seenIds = new Set<string>();
    const evidence = raw.evidence
      .map((e) => ({ id: e.id.trim(), shows: plainLine(e.shows, 200) }))
      .filter((e) => e.id && !seenIds.has(e.id) && seenIds.add(e.id));
    const outside = evidence.filter((e) => !i.ids.has(e.id));
    if (outside.length) {
      drop(`cited an id that is not in the evidence: ${outside.map((e) => e.id).join(", ")}`);
      continue;
    }
    if (evidence.length < 2) {
      drop("fewer than two citations");
      continue;
    }
    const f: ObserverFinding = {
      ...raw,
      title,
      evidence,
      a: Math.min(raw.a, MAX_A),
    };

    // OBV-6: an existing intent or proposal that covers it gets the evidence instead.
    const asked = new Set(raw.overlaps.map((o) => o.trim()));
    const hit = all.find((k) => k.aliases.some((a) => asked.has(a)) || norm(k.title) === norm(title));
    if (hit) {
      const key = hit.target ? `${hit.target.repo}#${hit.target.number}` : "";
      if (hit.target && hit.kind !== "late") {
        if (!commented.has(key)) {
          commented.add(key);
          res.comments.push({ target: hit.target, finding: f });
        }
      } else {
        res.seen.push({ title, links: [hit.link] });
      }
      continue;
    }

    if (!repos.has(f.repo)) {
      drop("unknown repo");
      continue;
    }

    // A closed proposal is a no (INT-53): only new evidence brings it back.
    const before = i.earlier.find((p) => norm(p.title) === norm(title));
    if (before) {
      let old: string[] = [];
      try {
        old = JSON.parse(before.evidence) as string[];
      } catch {
        // an unreadable record counts as no evidence
      }
      if (!evidence.some((e) => !old.includes(e.id))) {
        drop("proposed before and closed, with no new evidence");
        continue;
      }
    }
    if (proposedNow.has(norm(title))) {
      drop("the same title twice in one run");
      continue;
    }
    proposedNow.add(norm(title));
    queue.push(f);
  }

  // OBV-7: the best ranked first, as many as the week has room for.
  const rank = (f: ObserverFinding) => 2 * f.i + f.u;
  const sorted = queue.map((f, n) => ({ f, n })).sort((a, b) => rank(b.f) - rank(a.f) || a.n - b.n);
  const room = Math.max(0, i.config.observer.maxProposalsPerWeek - i.recent.length);
  res.propose = sorted.slice(0, room).map((x) => x.f);
  res.held = sorted.slice(room).map((x) => x.f);
  return res;
}
