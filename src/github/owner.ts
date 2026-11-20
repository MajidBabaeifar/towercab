// Acting as the owner (LOOP-38): what the owner starts from the UI or the CLI happens on GitHub
// under the owner's own `gh` login, never the App's.

import { type Forge, MERGE_METHOD, must } from "../forge.ts";
import type { IntentStore } from "../intents/types.ts";
import { agentMarker } from "./comments.ts";

/** The active github.com login in `gh auth status` output (gh 2.46 and older wordings). */
export function parseAuthStatus(text: string): string | null {
  let first: string | null = null;
  let last: string | null = null;
  for (const line of text.split("\n")) {
    const m = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(line);
    if (m) {
      last = m[1]!;
      first ??= last;
    } else if (last && /Active account: true/.test(line)) {
      return last;
    }
  }
  return first;
}

/** The owner's `gh` login; throws unless it is `[github].me` (case-insensitive). */
export async function ownerLogin(gh: Forge): Promise<string> {
  const who = await gh.activeOwnerLogin();
  if (!who) throw new Error(`gh isn't logged in to github.com as ${gh.me}: gh auth login`);
  if (who.toLowerCase() !== gh.me.toLowerCase()) {
    throw new Error(`gh is logged in as ${who}, not ${gh.me}: gh auth switch -u ${gh.me}`);
  }
  return who;
}

/** `approve`: squash-merge PR `pr` of `repo` as the owner. */
export async function approve(gh: Forge, repo: string, pr: number): Promise<void> {
  await ownerLogin(gh);
  must(await gh.asOwner().mergePr(repo, pr, { method: MERGE_METHOD }), "gh pr merge");
}

/** A reply from the UI: a comment on PR `pr` of `repo` as the owner. */
export async function reply(gh: Forge, repo: string, pr: number, text: string): Promise<void> {
  await ownerLogin(gh);
  must(await gh.asOwner().commentOnPr(repo, pr, text), "gh pr comment");
}

/** Drop from the UI: close PR `pr` of `repo` as the owner. */
export async function closePr(gh: Forge, repo: string, pr: number): Promise<void> {
  await ownerLogin(gh);
  must(await gh.asOwner().closePr(repo, pr), "gh pr close");
}

/**
 * The owner's answer: a comment on the current PR when there is one (the next PR read takes it
 * as feedback or `answered`); before any PR, appended to the intent's `## Answers` (INT-15), and
 * the caller applies `answered` with the text. Returns where it went.
 */
export async function answer(
  o: { gh: Forge; store: IntentStore },
  intent: string,
  pr: { repo: string; number: number } | null,
  text: string,
  at: Date,
): Promise<"pr" | "intent"> {
  if (!text.trim()) throw new Error("an answer needs text");
  if (pr) {
    await reply(o.gh, pr.repo, pr.number, text);
    return "pr";
  }
  await o.store.update(intent, "answer", (e) => e.addAnswer(text.trim(), at));
  return "intent";
}

/** PIP-184: an agent name is plain: letters, digits and `-`, up to 32 characters. */
export const AGENT_NAME = /^[A-Za-z0-9-]{1,32}$/;

/** PIP-184: the marker line, `🤖 <agent> (for <owner>)`, a blank line, then the text. */
export function agentReplyBody(agent: string, owner: string, text: string): string {
  return `${agentMarker(agent)}\n🤖 ${agent} (for ${owner})\n\n${text.trim()}\n`;
}

/** PIP-184: where `towercab reply` posts: the intent's current PR, else its issue; null when neither. */
export function replyTarget(
  pr: { repo: string; number: number } | null,
  issue: string | null,
): { kind: "pr" | "issue"; repo: string; number: number } | null {
  if (pr) return { kind: "pr", ...pr };
  const m = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/.exec(issue ?? "");
  return m ? { kind: "issue", repo: m[1]!, number: Number(m[2]) } : null;
}

/** PIP-184: post an agent's words under the owner's login, marked as the agent's. */
export async function agentReply(
  gh: Forge,
  to: { kind: "pr" | "issue"; repo: string; number: number },
  agent: string,
  owner: string,
  text: string,
): Promise<void> {
  if (!AGENT_NAME.test(agent))
    throw new Error(`--by wants a plain name (letters, digits, -; up to 32), got "${agent}"`);
  if (!text.trim()) throw new Error("a reply needs text");
  await ownerLogin(gh);
  const body = agentReplyBody(agent, owner, text);
  if (to.kind === "pr") must(await gh.asOwner().commentOnPr(to.repo, to.number, body), "gh pr comment");
  else await gh.asOwner().commentOnIssue(to.repo, to.number, body);
}
