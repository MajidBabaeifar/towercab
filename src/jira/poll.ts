// Jira tickets become intents (JIRA-2..6): every poll reads the tickets the owner's JQL returns, maps each
// to a repo, has a tool-less Claude run score it like a GitHub issue, and proposes the intent as a PR on the
// intents repo that only the owner's merge accepts. A ticket outside the filter is never read.

import type { JiraConfig } from "../config.ts";
import {
  bodyOf,
  type IssueDeps,
  intentsRepo,
  mentionedInUnreadable,
  type Poll,
  plain,
  propose,
  score,
} from "../github/issues.ts";
import { plainLine, TITLE_MAX } from "../intents/naming.ts";
import type { Intent, Listing, NewIntent } from "../intents/types.ts";
import { adfToText } from "./adf.ts";
import type { JiraClient, Ticket } from "./client.ts";
import { validKey } from "./key.ts";
import { failedMarker } from "./notes.ts";
import { repoFor } from "./repos.ts";

export interface JiraDeps extends IssueDeps {
  jira: JiraClient;
}

/** The longest description a scoring run reads. */
const BODY_MAX = 20_000;

/** JIRA-5: the intents-repo branch a ticket's intent is proposed from. */
export function jiraBranch(repo: string, key: string): string {
  return `jira/${repo}-${key}`;
}

/** JIRA-6: what the scoring run reads: the summary, the labels and the description as plain text. */
export function ticketText(t: Ticket): string {
  const body = adfToText(t.description);
  const cut = body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}\n[cut]` : body;
  return `Title: ${plainLine(t.summary, 300)}\nLabels: ${t.labels.join(", ") || "none"}\n\n${cut}`;
}

function failedComment(): string {
  return "Towercab could not turn this ticket into a description of work: its scoring run gave no usable answer twice. Please write the intent by hand in the intents repo.";
}

async function pollTicket(
  d: JiraDeps,
  cfg: JiraConfig,
  poll: Poll,
  t: Ticket,
  listing: Listing,
  known: Map<string, Intent>,
): Promise<void> {
  const key = validKey(t.key);
  if (!key) return;
  // JIRA-5: one intent per ticket, ever; the comments on it come from the sync.
  if (known.has(key)) return;
  const where = repoFor(cfg, t);
  if ("skip" in where) {
    d.log(`${key}: skipped: ${where.skip}`);
    return;
  }
  const repo = d.config.repos.get(where.repo);
  if (!repo) {
    d.log(`${key}: skipped: ${where.repo} isn't a repo Towercab works on`);
    return;
  }
  // JIRA-5: an unreadable intent file that names the ticket still counts.
  if (await mentionedInUnreadable(d, listing, `jira: ${key}`)) return;
  // JIRA-5: a PR from the ticket's branch, in any state, is its one proposal; a closed one is a no.
  const branch = jiraBranch(repo.name, key);
  const intents = intentsRepo(poll);
  if ((await d.github.prsOnBranch(intents, branch)).length) return;
  // JIRA-6: scoring failed twice before; the owner writes the intent by hand.
  const failed = failedMarker(key);
  if ((await d.jira.findMarkers(key, [failed])).has(failed)) return;
  // JIRA-2: the ticket may have left the filter since the list.
  const fresh = await d.jira.lookup(key);
  if (!fresh) return;

  const scored = await score(d, ticketText(fresh), repo.name);
  if (scored.kind === "later") {
    d.log(`${key}: not scored, trying again later: ${scored.why}`);
    return;
  }
  if (scored.kind === "bad") {
    d.log(`${key}: scoring failed twice: ${scored.why}`);
    await d.jira.addComment(key, `${failedComment()}\n\n${failed}`);
    return;
  }
  const s = scored.value;
  const n: NewIntent = {
    repo: repo.name,
    title: plainLine(s.title, TITLE_MAX) || key,
    u: s.u,
    i: s.i,
    // JIRA-6: as an issue's, with no label to change it.
    a: d.config.intents.issueA,
    source: "jira",
    fields: { jira: key },
    body: bodyOf(s),
  };
  const reasons = [
    `- Urgency ${s.u} of 5: ${plain(s.u_why)}`,
    `- Importance ${s.i} of 5: ${plain(s.i_why)}`,
  ].join("\n");
  const url = await propose(d, poll, listing, branch, n, `${cfg.site}/browse/${key}`, reasons, false, key);
  d.log(`${key}: proposed as ${url}`);
}

/**
 * JIRA-4: one poll. A ticket that fails does not stop the others; the failures come back as one error,
 * which the loop records as a Jira fault, never as an intent's.
 */
export async function pollJira(d: JiraDeps): Promise<void> {
  const cfg = d.config.jira;
  if (!cfg) return;
  const tickets = await d.jira.eligible();
  const listing = await d.store.list();
  const known = new Map<string, Intent>();
  for (const i of [...listing.open, ...listing.done]) {
    const k = validKey(i.jira);
    if (k) known.set(k, i);
  }
  const poll: Poll = { intents: d.store.github(), taken: null };
  const errors: string[] = [];
  for (const t of tickets) {
    try {
      await pollTicket(d, cfg, poll, t, listing, known);
    } catch (e) {
      errors.push(`${t.key}: ${(e as Error).message}`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
}
