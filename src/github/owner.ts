// Acting as the owner (LOOP-38): what the owner starts from the UI or the CLI happens on GitHub
// under the owner's own `gh` login, never the App's.

import type { GitHub } from "../handlers.ts";
import type { IntentStore } from "../intents/types.ts";
import { check } from "../tools.ts";

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
export async function ownerLogin(gh: GitHub): Promise<string> {
  const r = await gh.owner(["auth", "status", "--hostname", "github.com"]);
  const who = parseAuthStatus(`${r.stdout}\n${r.stderr}`);
  if (!who) throw new Error(`gh isn't logged in to github.com as ${gh.me}: gh auth login`);
  if (who.toLowerCase() !== gh.me.toLowerCase()) {
    throw new Error(`gh is logged in as ${who}, not ${gh.me}: gh auth switch -u ${gh.me}`);
  }
  return who;
}

/** `approve`: squash-merge PR `pr` of `repo` as the owner. */
export async function approve(gh: GitHub, repo: string, pr: number): Promise<void> {
  await ownerLogin(gh);
  check(await gh.owner(["pr", "merge", String(pr), "-R", repo, "--squash"]), "gh pr merge");
}

/** A reply from the UI: a comment on PR `pr` of `repo` as the owner. */
export async function reply(gh: GitHub, repo: string, pr: number, text: string): Promise<void> {
  await ownerLogin(gh);
  check(
    await gh.owner(["pr", "comment", String(pr), "-R", repo, "--body-file", "-"], { input: text }),
    "gh pr comment",
  );
}

/** Drop from the UI: close PR `pr` of `repo` as the owner. */
export async function closePr(gh: GitHub, repo: string, pr: number): Promise<void> {
  await ownerLogin(gh);
  check(await gh.owner(["pr", "close", String(pr), "-R", repo]), "gh pr close");
}

/**
 * The owner's answer: a comment on the current PR when there is one (the next PR read takes it
 * as feedback or `answered`); before any PR, appended to the intent's `## Answers` (INT-15), and
 * the caller applies `answered` with the text. Returns where it went.
 */
export async function answer(
  o: { gh: GitHub; store: IntentStore },
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
