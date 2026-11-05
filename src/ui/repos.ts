// The Repos tab (UI-140 to UI-145): a chip per repo; the chosen repo's feature list, what is in
// progress, up next, waiting and parked, and its spend; with no repo chosen, a short summary per repo.
// The lanes are the queue's (UI-63), the spend the board's (UI-137).

import type { Db } from "../db.ts";
import { featuresRun } from "../features.ts";
import { type Feature, featuresPath, hasOwnLines, parseFeatures } from "../intents/features.ts";
import { missingPermission, PERMISSION_STEP, storedSettings } from "../settings/store.ts";
import { proposedFor, proposedSection } from "./proposed.ts";
import { readinessBadge, setupView } from "./readiness.ts";
import { type RepoSpend, repoSpendView, spendByRepo, spendTotals } from "./spend.ts";
import { ago, dbMark, lanesOf, type Snap, snapshot, type UiSources, versionOf } from "./state.ts";
import type {
  FeaturesView,
  FeatureView,
  Lane,
  RepoSummary,
  ReposPage,
  RepoView,
  SettingsView,
} from "./view.ts";

export interface ReposOpts {
  /**
   * UI-144: asks for a repo's first backfill (the `features` action). Given only while Towercab runs;
   * called once, when a configured repo's page is shown and its list has never been read from the repo.
   */
  ask?: (repo: string) => Promise<unknown>;
}

/** The Repos tab's data (`GET /api/repos[?repo=<name>]`). */
export async function repos(src: UiSources, selected: string | null, o: ReposOpts = {}): Promise<ReposPage> {
  const s = await snapshot(src);
  const lanes = lanesOf(src, s);
  const by = spendByRepo(src.db, s.now);
  const badge = (repo: string) => {
    const readiness = readinessBadge(src.db, repo);
    return readiness ? { readiness } : {};
  };
  const chips = lanes.map((l) => ({
    repo: l.repo,
    open: l.running.length + l.upNext.length + l.waiting.length + l.parked.length,
    needs: l.running.filter((r) => r.state.key === "needs").length,
    ...badge(l.repo),
  }));
  let error = s.listError
    ? `The intents repo can't be read, so only started intents are shown: ${s.listError}`
    : null;
  const lane = selected ? (lanes.find((l) => l.repo === selected) ?? null) : null;
  if (selected && !lane) error = `There is no repo named “${selected}”. These are all of them.`;
  const repo = lane ? await repoView(src, s, lane, by.get(lane.repo), o) : null;
  const all: RepoSummary[] = lane
    ? []
    : lanes.map((l) => ({
        repo: l.repo,
        github: l.github,
        inProgress: l.running.length,
        needs: l.running.filter((r) => r.state.key === "needs").length,
        upNext: l.upNext.length,
        waiting: l.waiting.length,
        parked: l.parked.length,
        spend: repoSpendView(by.get(l.repo)),
        ...badge(l.repo),
      }));
  const body = {
    chips,
    selected: lane ? lane.repo : null,
    repo,
    all,
    spend: repoSpendView(spendTotals(by)),
    settingsStep: missingPermission(src.db) ? { text: PERMISSION_STEP, canGrant: src.running } : null,
    error,
  };
  return { version: versionOf(body, `${dbMark(src.db)}:${s.listing?.head ?? ""}`), ...body };
}

/**
 * UI-168: the repo's reviewers, and a warning when the host's required approvals (the figure the gate
 * and `doctor` last read, kept in `meta`) are more than the listed reviewers, with no code owners to
 * make up the rest (an empty list leaves that to the PR's card, PIP-147).
 */
export function teammateView(
  src: UiSources,
  repo: string,
  reviewers: string[],
): { reviewers: string[]; warning: string | null } {
  const cached = src.db.meta(`required:${repo}`);
  const required = cached && cached.split(" ")[1] !== "?" ? Number(cached.split(" ")[1]) : null;
  const warning =
    required !== null && reviewers.length > 0 && required > reviewers.length
      ? `GitHub needs ${required} approvals and your reviewers can give ${reviewers.length}: add reviewers with towercab repo set ${repo} reviewers=…`
      : null;
  return { reviewers, warning };
}

async function repoView(
  src: UiSources,
  s: Snap,
  lane: Lane,
  spend: RepoSpend | undefined,
  o: ReposOpts,
): Promise<RepoView> {
  const setup = setupView(src.db, lane.repo, s.listing, src.proposed?.().list ?? []);
  const cfg = src.config.repos.get(lane.repo);
  return {
    ...(setup ? { setup } : {}),
    ...(cfg?.teammateReview ? { teammate: teammateView(src, lane.repo, cfg.reviewers ?? []) } : {}),
    repo: lane.repo,
    github: lane.github,
    ahead: lane.ahead,
    settings: settingsView(src.db, lane.repo, src.running),
    proposed: proposedFor(proposedSection(src), src, lane.repo),
    features: await featuresView(src, s, lane, o),
    inProgress: lane.running,
    upNext: lane.upNext,
    waiting: lane.waiting,
    parked: lane.parked,
    done: lane.done,
    spend: repoSpendView(spend),
  };
}

/** REPO-30, REPO-32: the stored settings check in plain words; no network. */
export function settingsView(db: Db, repo: string, canGrant = true): SettingsView {
  const s = storedSettings(db, repo);
  const step = missingPermission(db) ? PERMISSION_STEP : null;
  if (!s || (s.state === "unknown" && s.at === 0))
    return { state: "unknown", summary: "Not checked yet", gaps: [], notes: [], at: 0, step, canGrant };
  const notes = [s.ruleset, s.note].filter((x): x is string => Boolean(x));
  const summary =
    s.state === "ok"
      ? "Standard settings in place"
      : s.state === "gaps"
        ? `${s.gaps.length} standard setting${s.gaps.length === 1 ? " differs" : "s differ"}`
        : "The standard settings could not be checked";
  return { state: s.state, summary, gaps: s.gaps, notes, at: s.at, step, canGrant };
}

const view = (f: Feature): FeatureView => ({ text: f.text, intent: f.intent });

/** UI-143, UI-144: the list grouped, queued intents as planned, and where the backfill stands. */
export async function featuresView(
  src: UiSources,
  s: Snap,
  lane: Lane,
  o: ReposOpts = {},
): Promise<FeaturesView> {
  const path = featuresPath(lane.repo);
  let text: string | null = null;
  let readError: string | null = null;
  try {
    text = await src.store.localFeatures(lane.repo);
  } catch (e) {
    readError = (e as Error).message;
  }
  const lines = parseFeatures(text);
  const tagged = new Set(lines.flatMap((f) => (f.intent ? [f.intent] : [])));
  // INT-40: planned is the file's planned lines, then the queued intents no line names yet.
  const planned: FeatureView[] = [
    ...lines.filter((f) => f.status === "planned").map(view),
    ...[...lane.upNext, ...lane.waiting]
      .filter((i) => !tagged.has(i.intent))
      .map((i) => ({ text: i.title, intent: i.intent })),
  ];
  const known = src.config.repos.has(lane.repo);
  const r = featuresRun(src.db, lane.repo);
  let run: FeaturesView["run"] = r?.state ?? "never";
  if (run === "never" && known && o.ask && readError === null && !hasOwnLines(text)) {
    try {
      await o.ask(lane.repo);
      run = "due";
    } catch {
      // Asked again on the next read.
    }
  }
  const gh = src.store.github();
  return {
    inProgress: lines.filter((f) => f.status === "in progress").map(view),
    live: lines.filter((f) => f.status === "live").map(view),
    planned,
    url: gh && text !== null ? `https://github.com/${gh}/blob/main/${path}` : null,
    run,
    note: readError
      ? `The feature list can't be read: ${readError}`
      : noteOf(run, r, s.now, known, hasOwnLines(text)),
    canRefresh: src.running && known && run !== "due" && run !== "running",
  };
}

function noteOf(
  run: FeaturesView["run"],
  r: ReturnType<typeof featuresRun>,
  now: number,
  known: boolean,
  own: boolean,
): string | null {
  switch (run) {
    case "never":
      if (own || !known) return null;
      return "Towercab writes this list from the repo's README and specs once it runs.";
    case "due":
      return "Towercab will read the repo's README and specs to list what is live, as soon as new work may start.";
    case "running":
      return "Towercab is reading the repo's README and specs to list what is live.";
    case "done":
      return r
        ? `Last read from the repo ${at(r.at, now)}: ${r.n ?? 0} live feature${r.n === 1 ? "" : "s"}.`
        : null;
    case "failed":
      return r ? `Reading the repo failed ${at(r.at, now)}: ${r.why ?? "no reason given"}.` : null;
  }
}

/** `12 min ago`, `yesterday 14:05`, `on Fri 14:05`, `on 12 Oct`. */
function at(t: number, now: number): string {
  const a = ago(t, now);
  return a.endsWith("ago") || a === "just now" || a.startsWith("yesterday") ? a : `on ${a}`;
}
