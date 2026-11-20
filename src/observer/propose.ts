// The observer's only actions (OBV-11): open a proposal on the intents repo, and comment evidence on a
// pull request that already covers the same thing. Nothing here merges, closes, edits an intent on `main`
// or changes a setting. This is the only file of the observer that touches GitHub.

import type { Config } from "../config.ts";
import { prsOnBranch } from "../github/branches.ts";
import { forgeOf } from "../github/forge.ts";
import type { GitHub } from "../handlers.ts";
import type { Home } from "../home.ts";
import { newId, slugOf } from "../intents/id.ts";
import { intentText } from "../intents/store.ts";
import type { IntentStore, Listing } from "../intents/types.ts";
import { commitToIntents } from "../pipeline/plan.ts";
import type { ObserverFinding } from "../pipeline/schemas.ts";
import type { Tools } from "../tools.ts";
import { MAX_A, type Target } from "./findings.ts";

export interface ProposeDeps {
  config: Config;
  home: Home;
  tools: Tools;
  github: GitHub;
  store: IntentStore;
  now: number;
}

/** OBV-12: the branch of a proposal. A replay after a crash finds the pull request it already opened. */
export const proposalBranch = (run: number, n: number) => `observer/${run}-${n}`;

/** The mark in a proposal's body. */
export const observerMark = (run: number) => `<!-- towercab:observer run=${run} -->`;

/** A link for one cited id: a pull request on GitHub, an intent in the page, or just the id. */
export function evidenceLink(config: Config, id: string): string {
  const pr = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(id);
  if (pr) return `[${id}](https://github.com/${pr[1]}/pull/${pr[2]})`;
  const ui = config.telegram?.uiUrl;
  return ui ? `[${id}](${ui.replace(/\/$/, "")}/i/${id})` : `\`${id}\``;
}

function evidenceList(config: Config, f: ObserverFinding): string {
  return f.evidence.map((e) => `- ${evidenceLink(config, e.id)}: ${e.shows}`).join("\n");
}

/** The intent file's body: the problem with its evidence, then the outcome with its expected gain. */
export function proposalBody(config: Config, f: ObserverFinding): string {
  return [
    "## Problem",
    "",
    f.problem.trim(),
    "",
    "### Evidence",
    "",
    evidenceList(config, f),
    "",
    "## Proposed outcome",
    "",
    f.outcome.trim(),
    "",
    "### Expected gain",
    "",
    f.gain.trim(),
  ].join("\n");
}

export interface Opened {
  pr: number;
  intent: string;
  /** A pull request on the branch already existed (a replay), so nothing was pushed. */
  existed: boolean;
}

/**
 * OBV-4: one pull request on the intents repo adding one intent file with `source: observer`. `taken` holds
 * the intent ids in use, and gains the new one.
 */
export async function openProposal(
  d: ProposeDeps,
  run: number,
  n: number,
  f: ObserverFinding,
  listing: Listing | null,
  taken: Set<string>,
): Promise<Opened> {
  const intents = d.store.github();
  if (!intents) throw new Error("the intents repo isn't on GitHub, so a proposal can't be opened");
  const branch = proposalBranch(run, n);
  const there = (await prsOnBranch(d.github, intents, branch))[0];
  if (there) return { pr: there.number, intent: "", existed: true };

  const now = new Date(d.now * 1000);
  const used = new Set<string>([
    ...taken,
    ...(listing
      ? [
          ...listing.open.map((i) => i.id),
          ...listing.done.map((i) => i.id),
          ...listing.doneIds,
          ...listing.unreadable.flatMap((u) => (u.id ? [u.id] : [])),
        ]
      : []),
  ]);
  const id = newId(now, used);
  taken.add(id);
  const text = intentText(
    {
      repo: f.repo,
      title: f.title,
      u: f.u,
      i: f.i,
      a: Math.min(f.a, MAX_A),
      source: "observer",
      body: proposalBody(d.config, f),
    },
    now,
  );
  const prTitle = `docs(intents): add ${id} ${f.title}`;
  const cx = { config: d.config, home: d.home, tools: d.tools, github: d.github, store: d.store };
  const files = { [`intents/${id}-${slugOf(f.title)}/intent.md`]: text };
  await commitToIntents(cx, branch, "origin/main", files, prTitle, "observer");
  const pr = await forgeOf(d.github).openPr(intents, {
    base: "main",
    head: branch,
    title: prTitle,
    body: [
      observerMark(run),
      "The observer read how Towercab ran over the last two weeks and found this pattern. The evidence and the expected gain are in the intent.",
      "Merging this pull request accepts it as work. Closing it says no; the observer will not propose it again without new evidence.",
    ].join("\n\n"),
  });
  if (!pr) throw new Error("GitHub opened the proposal but gave no pull request number");
  return { pr, intent: id, existed: false };
}

/** OBV-6: new evidence on a pull request that already covers the finding. */
export async function commentEvidence(d: ProposeDeps, target: Target, f: ObserverFinding): Promise<void> {
  const text = [
    "**Observer**: the observer saw this again and has new evidence.",
    "",
    f.problem.trim(),
    "",
    evidenceList(d.config, f),
    "",
    `Expected gain: ${f.gain.trim()}`,
  ].join("\n");
  const r = await forgeOf(d.github).commentOnPr(target.repo, target.number, text);
  if (!r.ok) throw new Error(`comment on ${target.repo}#${target.number}: ${r.reason.split("\n")[0]}`);
}
