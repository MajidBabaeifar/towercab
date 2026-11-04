// Stage comments (PIP-42): a visible `**<Step>** · round <n>` header and a hidden first-line marker,
// so a comment for the same step and round is edited instead of added again.

import type { GitHub } from "../handlers.ts";
import { check } from "../tools.ts";
import { isBot } from "./events.ts";
import { jsonStream } from "./prs.ts";

export const STEPS = [
  "Design",
  "Plan",
  "Build",
  "Verify",
  "Proof",
  "CI",
  "Review",
  "Gate",
  "Question",
  "Answer",
  "Access",
] as const;
export type Step = (typeof STEPS)[number];

/** `<!-- towercab:<step>:<round> -->`, the step lowercased. */
export function stageMarker(step: Step, round: number): string {
  return `<!-- towercab:${step.toLowerCase()}:${round} -->`;
}

/** The comment's whole text: marker, header, a blank line, `body`. */
export function stageComment(step: Step, round: number, body: string): string {
  return `${stageMarker(step, round)}\n**${step}** · round ${round}\n\n${body.trim()}\n`;
}

/**
 * Post the step's comment on PR `pr` of `repo` as the App, or edit the bot's comment that already
 * carries its marker (`gh api repos/<r>/issues/<n>/comments`, PATCH). Returns whether it edited.
 */
export async function upsertStageComment(
  gh: GitHub,
  repo: string,
  pr: number,
  step: Step,
  round: number,
  body: string,
): Promise<{ edited: boolean }> {
  const text = stageComment(step, round, body);
  const marker = stageMarker(step, round);
  const listed = check(
    await gh.gh(repo, ["api", "--paginate", `repos/${repo}/issues/${pr}/comments?per_page=100`]),
    "gh api comments",
  );
  const bot = (await gh.bot()).login;
  let id: string | null = null;
  for (const page of jsonStream(listed, "gh api comments")) {
    for (const c of Array.isArray(page) ? page : []) {
      const o = c as { id?: unknown; body?: unknown; user?: { login?: unknown } };
      const first = typeof o.body === "string" ? (o.body.split("\n", 1)[0] ?? "").trim() : "";
      const author = typeof o.user?.login === "string" ? o.user.login : "";
      if (first === marker && isBot(author, bot) && typeof o.id === "number") id = String(o.id);
    }
  }
  if (id !== null) {
    check(
      await gh.gh(repo, ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${id}`, "--input", "-"], {
        input: JSON.stringify({ body: text }),
      }),
      "gh api PATCH comment",
    );
    return { edited: true };
  }
  check(
    await gh.gh(repo, ["pr", "comment", String(pr), "-R", repo, "--body-file", "-"], { input: text }),
    "gh pr comment",
  );
  return { edited: false };
}
