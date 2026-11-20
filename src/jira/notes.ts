// What a ticket is told (JIRA-7, JIRA-8): queued, started, each pull request, done, or stopped without
// merging. Only where the work stands: never a score, a reason, a place in the queue, an intent link or
// any text from the intent file. Every comment ends with a marker line naming its kind and intent; before
// posting, the ticket's comments are read only to look for those markers, so each comment is posted once
// and a failed one is retried on the next pass. Comments are only created, never edited or deleted.

import type { Config } from "../config.ts";
import type { Db } from "../db.ts";
import type { Intent, IntentStore } from "../intents/types.ts";
import type { Mission } from "../mission.ts";
import { prUrl } from "../pipeline/common.ts";
import type { JiraClient } from "./client.ts";
import { validKey } from "./key.ts";

/** JIRA-6: the marker of a ticket whose scoring failed twice. */
export const failedMarker = (key: string): string => `towercab:failed:${key}`;
const queuedMarker = (id: string): string => `towercab:queued:${id}`;
const progressMarker = (id: string, attempt: number): string => `towercab:progress:${id}:${attempt}`;
const prMarker = (url: string): string => `towercab:pr:${url}`;
const doneMarker = (id: string): string => `towercab:done:${id}`;
const stoppedMarker = (id: string, attempt: number): string => `towercab:stopped:${id}:${attempt}`;

/** JIRA-7: the only reasons a stopped comment gives. Nothing from the intent or a worker reaches the ticket. */
export const STOP_REASONS = {
  dropped: "The owner dropped this work.",
  closed: "The owner closed the pull request without merging it.",
  failed: "The work could not be completed.",
} as const;

interface Note {
  marker: string;
  text: string;
  kind: "queued" | "progress" | "pr" | "done" | "stopped";
}

/** A PR of the intent: what it holds, and where. */
interface Link {
  what: string;
  url: string;
}

const merged = (m: Mission): boolean =>
  m.merge_sha !== null || m.stage === "done" || m.stage === "unverified";

/** JIRA-7, JIRA-8: the comments an intent's ticket should have by now, in the order they are posted. */
export function notesFor(i: Intent, ms: Mission[], github: string | null, intents: string | null): Note[] {
  const done = ms.some(merged);
  const latest = ms.at(-1);
  const dropped = i.stage === "dropped";
  const notes: Note[] = [];
  const links: Link[] = [];
  const seen = new Set<string>();
  const add = (what: string, url: string) => {
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ what, url });
    }
  };
  for (const m of ms) {
    if (m.spec_pr !== null && github) add("requirements", prUrl(github, m.spec_pr));
    if (m.plan_pr !== null && intents) add("plan", prUrl(intents, m.plan_pr));
    if (m.pr !== null && github) add("code", prUrl(github, m.pr));
  }
  const stopped = !done && (dropped || latest?.stage === "stopped");

  if (!done && !dropped)
    notes.push({
      kind: "queued",
      marker: queuedMarker(i.id),
      text: "Towercab has queued this ticket as work. It will say here when the work starts, when a pull request is opened, and when it is merged.",
    });
  if (latest && !done && !stopped)
    notes.push({
      kind: "progress",
      marker: progressMarker(i.id, latest.attempt),
      text: "Work on this ticket has started.",
    });
  for (const l of links)
    notes.push({
      kind: "pr",
      marker: prMarker(l.url),
      text: `Towercab opened a pull request for the ${l.what}: ${l.url}`,
    });
  if (done) {
    const code = links.filter((l) => l.what === "code").at(-1);
    notes.push({
      kind: "done",
      marker: doneMarker(i.id),
      text: `This work is merged.${code ? ` Pull request: ${code.url}` : ""}`,
    });
  }
  if (stopped) {
    const why = latest?.stage === "stopped" ? (latest.why ?? "") : "";
    const reason =
      dropped || /^intent removed/.test(why)
        ? STOP_REASONS.dropped
        : /^PR closed/.test(why)
          ? STOP_REASONS.closed
          : STOP_REASONS.failed;
    notes.push({
      kind: "stopped",
      marker: stoppedMarker(i.id, latest?.attempt ?? 0),
      text: [
        "Stopped, not merged.",
        reason,
        ...(links.length ? [`Pull requests:\n${links.map((l) => `- ${l.url}`).join("\n")}`] : []),
      ].join("\n\n"),
    });
  }
  return notes;
}

export interface SyncDeps {
  config: Config;
  db: Db;
  store: IntentStore;
  jira: JiraClient;
  log(line: string): void;
}

/**
 * JIRA-7, JIRA-8: bring every Jira-born intent's ticket up to date. `settled` remembers, per process,
 * which intents were fully told for their current state, so a finished one costs no more reads. A ticket
 * that fails does not stop the others; the failures come back as one error (a Jira fault).
 */
export async function syncJira(d: SyncDeps, settled: Map<string, string>): Promise<void> {
  if (!d.config.jira) return;
  const listing = await d.store.list();
  const errors: string[] = [];
  for (const i of [...listing.open, ...listing.done]) {
    const key = validKey(i.jira);
    if (!key) continue;
    try {
      const ms = d.db.all<Mission>("SELECT * FROM missions WHERE intent = ? ORDER BY id", i.id);
      const repo = d.config.repos.get(i.repo);
      const notes = notesFor(i, ms, repo?.github ?? null, d.store.github());
      const state = notes.map((n) => n.marker).join("\n");
      if (settled.get(i.id) === state) continue;
      if (notes.length === 0) {
        settled.set(i.id, state);
        continue;
      }
      const have = await d.jira.findMarkers(
        key,
        // The markers that a later stopped comment looks back at, beside the ones due now.
        [...notes.map((n) => n.marker), doneMarker(i.id)],
      );
      let before =
        notes.some((n) => n.kind !== "stopped" && have.has(n.marker)) || have.has(doneMarker(i.id));
      for (const n of notes) {
        if (have.has(n.marker)) continue;
        // JIRA-7: a ticket never told anything is not told it stopped, and one told it is done never is.
        if (n.kind === "stopped" && (!before || have.has(doneMarker(i.id)))) continue;
        await d.jira.addComment(key, `${n.text}\n\n[${n.marker}]`);
        have.add(n.marker);
        if (n.kind !== "stopped") before = true;
      }
      settled.set(i.id, state);
    } catch (e) {
      errors.push(`${key}: ${(e as Error).message}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
}
