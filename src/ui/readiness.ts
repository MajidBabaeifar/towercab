// What the pages say about a repo's setup (UI-155..157): the badge, and the "Set up this repo" section.
// Both read the stored result (REPO-24), never the network.

import type { Db } from "../db.ts";
import type { ProposedPr } from "../github/proposed.ts";
import type { Listing } from "../intents/types.ts";
import { type Item, missing, openSetupPr, parseStored } from "../repo/readiness.ts";
import type { ReadinessBadge, SetupView, SharedGap } from "./view.ts";

/**
 * UI-270: a gap in plain words with what to do, and the raw error apart. A missing item's words already
 * say what to do; a check that failed gets a sentence of its own, or a general one for an unknown error.
 */
export function plainGap(
  item: string,
  state: "missing" | "unknown" | "waived",
  words: string,
): { plain: string; raw: string | null } {
  if (state !== "unknown") return { plain: state === "waived" ? `Waived: ${words}` : words, raw: null };
  if (words === "Not checked yet") return { plain: "Towercab has not checked this yet", raw: null };
  if (/HTTP 403|Resource not accessible|Must have admin rights/i.test(words)) {
    return {
      plain:
        item === "settings"
          ? "Towercab's GitHub App can't read this repo's workflow settings: give it the Actions permission"
          : "Towercab's GitHub App can't read this part of the repo: give it the permission it asks for",
      raw: words,
    };
  }
  return { plain: "Towercab could not check this", raw: words };
}

/** UI-269: what a shared gap is called in a line, per item. */
const SHARED_WORDS: Record<Item, string> = {
  kind: "no kind set",
  ci: "no CI with required checks",
  settings: "GitHub settings that differ",
  release: "no release job",
  verifying: "no verifying section",
  image: "no signed image",
  apps: "no entry in the apps list",
  deploy: "no deploy job",
  live: "no live check",
  publish: "no publish job",
  go_live: "no go-live line",
};

/**
 * UI-269: the items missing on at least 3 repos and on more than half of the repos with a stored result,
 * most common first. The Repos page and the Board both read this, so their counts agree.
 */
export function sharedGaps(db: Db, repos: Iterable<string>): SharedGap[] {
  const counts = new Map<Item, number>();
  let total = 0;
  for (const repo of repos) {
    const r = parseStored(db.meta(`readiness:${repo}`))?.readiness;
    if (!r) continue;
    total++;
    for (const i of missing(r)) counts.set(i.item, (counts.get(i.item) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, n]) => n >= 3 && n * 2 > total)
    .sort((a, b) => b[1] - a[1])
    .map(([item, count]) => ({ item, count, total, words: SHARED_WORDS[item] }));
}

/** UI-155: the badge, or undefined for a ready or unchecked repo. Shared gaps (UI-269) don't count. */
export function readinessBadge(db: Db, repo: string, shared: SharedGap[] = []): ReadinessBadge | undefined {
  const r = parseStored(db.meta(`readiness:${repo}`))?.readiness;
  if (!r) return undefined;
  const skip = new Set<string>(shared.map((g) => g.item));
  // A repo whose new work is held keeps its badge: that is never something to sum up.
  const items = r.blocks ? r.items : r.items.filter((i) => !(i.state === "missing" && skip.has(i.item)));
  const m = items.filter((i) => i.state === "missing").length;
  const unknown = items.filter((i) => i.state === "unknown").length;
  if (m === 0 && unknown === 0) return undefined;
  const label = r.blocks ? "Not ready · new work paused" : m > 0 ? "Not ready" : "Could not check";
  const parts = [
    ...(m > 0 ? [`${m} missing`] : []),
    ...(unknown > 0 ? [`${unknown} could not be checked`] : []),
  ];
  const detail = items
    .filter((i) => i.state === "missing" || i.state === "unknown")
    .map((i) => i.words)
    .join("; ");
  return { label, blocks: r.blocks, missing: m, unknown, detail, name: `${label}: ${parts.join(", ")}` };
}

/** UI-156: what a repo is missing, in words, with the lines that fix it. */
export function setupView(
  db: Db,
  repo: string,
  listing: Listing | null,
  proposed: ProposedPr[] = [],
): SetupView | undefined {
  const r = parseStored(db.meta(`readiness:${repo}`))?.readiness;
  if (!r) return undefined;
  const shown = r.items.filter((i) => i.state !== "present");
  if (shown.length === 0) return undefined;
  const m = missing(r).length;
  const hint: string[] = [];
  if (!r.confirmed && r.suggested) hint.push(`kind: ${r.suggested}`);
  if (!r.confirmed && !r.suggested) hint.push("kind: service | site | cli | library | spec-only | infra");
  if (r.confirmed && !r.blocks && m > 0) hint.push("readiness: block");
  const setup = listing?.open.find((i) => i.repo === repo && i.setup === true) ?? null;
  const pr = openSetupPr(proposed, repo);
  const sentence = r.blocks
    ? "New intents wait in this repo until these are done. The intent that sets it up can still run."
    : !r.confirmed
      ? "This is a warning only: new intents still start until you confirm the kind and set readiness to block."
      : m > 0
        ? "This is a warning only: new intents still start until you set readiness to block."
        : "Towercab could not check these; they never hold work back.";
  return {
    kind: r.kind,
    confirmed: r.confirmed,
    blocks: r.blocks,
    items: shown.map((i) => {
      const state = i.state as "missing" | "unknown" | "waived";
      return {
        item: i.item,
        state,
        words: state === "waived" ? `Waived: ${i.words}` : i.words,
        ...plainGap(i.item, state, i.words),
      };
    }),
    sentence,
    hint,
    intent: setup ? { id: setup.id, title: setup.title } : null,
    proposal: pr ? { url: pr.url, title: pr.intent?.title ?? pr.title } : null,
  };
}
