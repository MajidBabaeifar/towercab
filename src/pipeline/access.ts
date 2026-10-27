// Access (PIP-47, AUT-14, AUT-15): the plan's Access checklist, written and read back, and the
// grants a worker run gets at its effective autonomy.

import { accessPolicy } from "../autonomy.ts";
import type { Access } from "./schemas.ts";

/** What a worker run may reach: domains for the sandbox and WebFetch, writable protected globs, open network. */
export interface Grants {
  domains: string[];
  paths: string[];
  open: boolean;
}

/** What the level grants without asking, in one sentence for the owner (AUT-14). */
export function levelSentence(a: number | null): string {
  if (a === null) {
    return "This intent has no autonomy level, so the worker gets only the default package registries and docs plus the boxes ticked here, and Towercab merges the code itself only if the review finds it low-risk.";
  }
  if (a <= 3) {
    return `At a${a} you merge the code PR yourself, so the worker can reach the default package registries and docs plus the boxes ticked here, may change protected files (the PR lists them), and gets anything else it asks for while building.`;
  }
  if (a === 4) {
    return "At a4 the worker can reach the default package registries and docs plus the boxes ticked here, and may change only the protected paths ticked here; if it needs more while building, it gets it, but you merge the code PR.";
  }
  return "At a5 the worker has open network and may change protected files, and Towercab merges the code PR once every check passes.";
}

/** The plan's `## Access` section: the level's sentence, then one ticked line per domain and path. */
export function renderAccess(access: Access, a: number | null): string {
  const out = ["## Access", "", levelSentence(a), ""];
  const why = (w: string) => (w.trim() ? ` (${oneLine(w)})` : "");
  for (const d of access.domains) out.push(`- [x] network: ${d.domain}${why(d.why)}`);
  for (const p of access.paths) out.push(`- [x] path: ${p.glob}${why(p.why)}`);
  if (!access.domains.length && !access.paths.length) out.push("Nothing beyond what the level grants.");
  return `${out.join("\n")}\n`;
}

const LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(network|path):\s+(\S+)(?:\s+\((.*)\))?\s*$/;

/**
 * The ticked lines of a merged `plan.md`'s `## Access` section; unticked ones aren't granted, and
 * no section grants nothing beyond the defaults.
 */
export function parseAccess(planMd: string): Access {
  const access: Access = { domains: [], paths: [] };
  let inside = false;
  let fence = false;
  for (const line of planMd.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    if (/^#{1,2} /.test(line)) {
      inside = /^## +Access\s*$/i.test(line);
      continue;
    }
    if (!inside) continue;
    const m = LINE.exec(line);
    if (!m || m[1] === " ") continue;
    const why = m[4] ?? "";
    if (m[2] === "network") access.domains.push({ domain: m[3]!, why });
    else access.paths.push({ glob: m[3]!, why });
  }
  return access;
}

/** Inputs of `grantsFor`. */
export interface GrantInput {
  /** Effective `a` (`effectiveA`). */
  a: number | null;
  /** The intent's `source` (a5 needs `me`, AUT-13). */
  source: string | null;
  /** The merged plan's ticked access, or null before a plan. */
  plan: Access | null;
  /** The intent's own `unlock` and `network` fields. */
  unlock: string[];
  network: string[];
  /** `[agent].network`. */
  defaults: string[];
  /** Access granted mid-build (AUT-15, `data.unplanned`). */
  unplanned: Access | null;
}

/**
 * A worker run's grants (AUT-14): the default list, the plan's and the intent's domains and any
 * granted mid-build; protected paths: all (but `.git`) at a1–a3 and a5, else the plan's, the
 * intent's `unlock` and those granted mid-build; open network only at a5 for the owner's intents.
 */
export function grantsFor(g: GrantInput): Grants {
  const policy = accessPolicy(g.a);
  const domains = uniq([
    ...g.defaults,
    ...(g.plan?.domains.map((d) => d.domain) ?? []),
    ...g.network,
    ...(g.unplanned?.domains.map((d) => d.domain) ?? []),
  ]);
  const paths =
    policy.protectedPaths === "writable"
      ? ["**"]
      : uniq([
          ...(g.plan?.paths.map((p) => p.glob) ?? []),
          ...g.unlock,
          ...(g.unplanned?.paths.map((p) => p.glob) ?? []),
        ]);
  const own = g.source === null || g.source === "" || g.source === "me";
  return { domains, paths, open: policy.network === "open" && own };
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
