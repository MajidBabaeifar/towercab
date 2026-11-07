// The pick decision (LOOP-5, PRI-5) and `towercab next`'s text (LOOP-13). Pure: the loop's pick step
// (fetch, repo files, checkout) and the writes it decides are the loop's.

import type { Intent, Listing } from "./intents/types.ts";
import { DEFAULT_SCORE, isParked, isQueued, pickOrder, priorityOf } from "./priority.ts";

/** One repo's intents ahead of build: `working` take a place, `owner` wait for the owner (LOOP-100). */
export interface Places {
  working: number;
  owner: number;
  /** `[repos.<r>].ahead`. */
  limit: number;
  /** `[intents].owner_waits` (LOOP-132). */
  ownerLimit: number;
  /** The intents ahead, working or waiting. */
  ids: string[];
}

/** Why a repo holds an intent back: the places of working intents (LOOP-100) or `owner_waits` (LOOP-132). */
export type Held =
  | { kind: "working"; working: number; limit: number }
  | { kind: "owner"; owner: number; limit: number };

/**
 * LOOP-100, LOOP-101, LOOP-132: null when the intent may start. `owner_waits` intents waiting on the owner
 * hold every intent; else one that outranks every intent ahead (a tie does not) may; else `ahead` working
 * intents hold it.
 */
export function heldBack(places: Places | undefined, intent: Intent, listing: Listing): Held | null {
  if (!places) return null;
  const { working, owner, limit, ownerLimit } = places;
  if (owner >= ownerLimit) return { kind: "owner", owner, limit: ownerLimit };
  const p = priorityOf(intent);
  const prio = new Map(listing.open.map((i) => [i.id, priorityOf(i)]));
  if (places.ids.every((id) => p > (prio.get(id) ?? 0))) return null;
  if (working >= limit) return { kind: "working", working, limit };
  return null;
}

/** What a pick depends on besides the intents. */
export interface PickState {
  /** `[intents].cutoff`. */
  cutoff: number;
  /** `meta.paused`. */
  paused: boolean;
  /** GitHub or Claude unreachable (LOOP-10): the reason in plain words, else null. */
  blocked: string | null;
  /** `[repos]` names. */
  repos: Set<string>;
  /** Every repo's intents ahead of build (LOOP-60, LOOP-100): working, waiting on the owner, the limit. */
  full: Map<string, Places>;
  /** Intents the owner started with `start` (LOOP-63): they go over the limit, first. */
  started?: Set<string>;
  /** GitLab repos (GL-3): added, but the pipeline can't work on them yet, so none of their intents is picked. */
  unsupported?: Set<string>;
  /** Repos set to block while not ready (LOOP-70) → `<n> missing (<items>)`. */
  notReady?: Map<string, string>;
  /** Models cooling down (LOOP-9) → until, as shown (`15:30`). */
  cooling: Map<string, string>;
  /** Intents with an unfinished mission: never picked again (LOOP-4). */
  active: Set<string>;
  /** `[agent].model`: an intent without `model` runs on it. */
  defaultModel: string;
}

/** The picker's answer. */
export interface Decision {
  pick: Intent | null;
  /** Intents passed over, in order, and why (plain words). */
  skipped: { id: string; reason: string }[];
  /** Waits to write on the intent without a mission (`unknown repo` + the repo, `bad after:` + the IDs, `bad repos:` + the names). */
  writes: { id: string; waiting: string; why: string }[];
}

/**
 * LOOP-5, LOOP-117: for an intent and its `after` list, the IDs that are unknown or cyclic, sorted;
 * dropped ones too unless `dropped` is false (a mission that already runs tells the owner of those itself).
 */
export function afterChecker(listing: Listing): (id: string, after: string[], dropped?: boolean) => string[] {
  const open = new Map(listing.open.map((i) => [i.id, i.after]));
  const done = new Set([...listing.doneIds, ...listing.done.map((i) => i.id)]);
  // `target` reachable from `from` over `after` edges among open intents.
  const reaches = (from: string, target: string) => {
    const seen = new Set<string>();
    const todo = [from];
    while (todo.length) {
      const at = todo.pop()!;
      if (at === target) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      todo.push(...(open.get(at) ?? []));
    }
    return false;
  };
  return (id, after, dropped = true) =>
    [...new Set(after)]
      .filter(
        (a) =>
          (dropped && listing.droppedIds.has(a)) ||
          (!listing.droppedIds.has(a) && !open.has(a) && !done.has(a)) ||
          (open.has(a) && reaches(a, id)),
      )
      .sort();
}

/** Queued intents whose `after` names an unknown, dropped or cyclic intent → their bad IDs, sorted. */
export function badAfter(listing: Listing): { id: string; ids: string[] }[] {
  const check = afterChecker(listing);
  const out: { id: string; ids: string[] }[] = [];
  for (const i of listing.open.filter(isQueued)) {
    const bad = check(i.id, i.after);
    if (bad.length) out.push({ id: i.id, ids: bad });
  }
  return out;
}

/** LOOP-102: which rule held the intent back, as `status` and `next` word it. */
export function heldText(h: Held, id: string): string {
  return h.kind === "owner"
    ? `repo has ${h.owner} intents waiting on you (start ${id} to go now)`
    : `repo has ${h.working} intents working ahead (start ${id} to go now)`;
}

/** Why an intent on a GitLab repo is not picked: the pipeline is GitHub-only for now. */
export const GITLAB_NOT_YET = (repo: string): string =>
  `${repo} is a GitLab repo and the pipeline doesn't support GitLab yet: its intents wait`;

/** LOOP-5: the picker's list (PRI-5) in order; the first intent nothing skips is picked. */
export function decide(listing: Listing, state: PickState): Decision {
  const d: Decision = { pick: null, skipped: [], writes: [] };
  for (const { id, ids } of badAfter(listing)) {
    if (state.active.has(id)) continue;
    d.writes.push({ id, waiting: "bad after:", why: ids.join(", ") });
    d.skipped.push({ id, reason: `bad after: ${ids.join(", ")}` });
  }
  const started = state.started ?? new Set<string>();
  const order = pickOrder(listing, state.cutoff);
  const queue = [...order.filter((i) => started.has(i.id)), ...order.filter((i) => !started.has(i.id))];
  for (const i of queue) {
    if (state.active.has(i.id)) continue;
    // Parked intents wait for the owner: listed, never picked, nothing written.
    const p = priorityOf(i);
    if (isParked(p, state.cutoff)) {
      d.skipped.push({ id: i.id, reason: `parked (p${p} < ${state.cutoff}): raise u or i to run it` });
      continue;
    }
    if (!state.repos.has(i.repo)) {
      d.writes.push({ id: i.id, waiting: "unknown repo", why: i.repo });
      d.skipped.push({ id: i.id, reason: `unknown repo ${i.repo}` });
      continue;
    }
    if (state.unsupported?.has(i.repo)) {
      d.skipped.push({ id: i.id, reason: GITLAB_NOT_YET(i.repo) });
      continue;
    }
    // INT-42: every other repo of a multi-repo intent must be one Towercab knows, and ready.
    const others = i.repos ?? [];
    const unknown = others.filter((r) => !state.repos.has(r));
    if (unknown.length) {
      d.writes.push({ id: i.id, waiting: "bad repos:", why: unknown.join(", ") });
      d.skipped.push({ id: i.id, reason: `bad repos: ${unknown.join(", ")}` });
      continue;
    }
    const heldBy = others.find((r) => state.notReady?.has(r));
    if (heldBy !== undefined) {
      d.skipped.push({ id: i.id, reason: `repo ${heldBy} not ready: ${state.notReady!.get(heldBy)}` });
      continue;
    }
    // LOOP-70: a blocking repo starts nothing new, except the intent that sets it up (LOOP-71).
    const notReady = state.notReady?.get(i.repo);
    if (notReady !== undefined && i.setup !== true) {
      d.skipped.push({ id: i.id, reason: `repo not ready: ${notReady}` });
      continue;
    }
    if (notReady !== undefined) {
      const other = listing.open.find(
        (x) => x.id !== i.id && x.setup === true && x.repo === i.repo && state.active.has(x.id),
      );
      if (other) {
        d.skipped.push({ id: i.id, reason: `${other.id} is already setting up ${i.repo}` });
        continue;
      }
    }
    const model = i.model ?? state.defaultModel;
    const held = started.has(i.id) ? null : heldBack(state.full.get(i.repo), i, listing);
    const until = state.cooling.get(model);
    const reason = state.paused
      ? "paused"
      : state.blocked !== null
        ? state.blocked
        : held
          ? heldText(held, i.id)
          : until !== undefined
            ? `${model} cooling until ${until}`
            : null;
    if (reason === null) {
      d.pick = i;
      break;
    }
    d.skipped.push({ id: i.id, reason });
  }
  return d;
}

/** Open intents with a `stage`, no `waiting` and no unfinished mission (after a crash): they lose their `stage`. */
export function orphans(listing: Listing, unfinishedIntentIds: Set<string>): string[] {
  return listing.open
    .filter((i) => i.stage !== null && i.waiting === null && !unfinishedIntentIds.has(i.id))
    .map((i) => i.id);
}

/** `towercab next` (LOOP-13): the intent the picker would take, then each skipped one with its reason. */
export function nextText(decision: Decision, listing: Listing, cutoff: number): string {
  const byId = new Map(listing.open.map((i) => [i.id, i]));
  const label = (id: string) => {
    const i = byId.get(id);
    return i ? `${id} ${i.repo}: ${i.title}` : id;
  };
  const lines: string[] = [];
  const p = decision.pick;
  if (p) {
    const scores = `p${priorityOf(p)} u${p.u ?? DEFAULT_SCORE} i${p.i ?? DEFAULT_SCORE}${p.a === null ? "" : ` a${p.a}`}`;
    const why = isParked(p, cutoff) ? "parked, named by the owner" : "highest priority that can run";
    lines.push(`next: ${label(p.id)} · ${scores} · ${why}`);
  } else {
    lines.push(listing.open.length ? "next: nothing can run now" : "next: nothing open");
  }
  for (const s of decision.skipped) lines.push(`skipped: ${label(s.id)} · ${s.reason}`);
  return `${lines.join("\n")}\n`;
}
