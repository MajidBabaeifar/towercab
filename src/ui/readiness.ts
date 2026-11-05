// What the pages say about a repo's setup (UI-155..157): the badge, and the "Set up this repo" section.
// Both read the stored result (REPO-24), never the network.

import type { Db } from "../db.ts";
import type { ProposedPr } from "../github/proposed.ts";
import type { Listing } from "../intents/types.ts";
import { missing, openSetupPr, parseStored } from "../repo/readiness.ts";
import type { ReadinessBadge, SetupView } from "./view.ts";

/** UI-155: the badge, or undefined for a ready or unchecked repo. */
export function readinessBadge(db: Db, repo: string): ReadinessBadge | undefined {
  const r = parseStored(db.meta(`readiness:${repo}`))?.readiness;
  if (!r) return undefined;
  const m = missing(r).length;
  const unknown = r.items.filter((i) => i.state === "unknown").length;
  if (m === 0 && unknown === 0) return undefined;
  const label = r.blocks ? "Not ready · new work paused" : m > 0 ? "Not ready" : "Could not check";
  const parts = [
    ...(m > 0 ? [`${m} missing`] : []),
    ...(unknown > 0 ? [`${unknown} could not be checked`] : []),
  ];
  const detail = r.items
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
    items: shown.map((i) => ({
      item: i.item,
      state: i.state as "missing" | "unknown" | "waived",
      words: i.state === "waived" ? `Waived: ${i.words}` : i.words,
    })),
    sentence,
    hint,
    intent: setup ? { id: setup.id, title: setup.title } : null,
    proposal: pr ? { url: pr.url, title: pr.intent?.title ?? pr.title } : null,
  };
}
