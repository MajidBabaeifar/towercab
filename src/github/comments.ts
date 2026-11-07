// Stage comments (PIP-42): a visible `**<Step>** · round <n>` header and a hidden first-line marker,
// so a comment for the same step and round is edited instead of added again.

import type { Forge } from "../forge.ts";
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
  "Intake",
] as const;
export type Step = (typeof STEPS)[number];

/** `<!-- towercab:<step>:<round> -->`, the step lowercased. */
export function stageMarker(step: Step, round: number): string {
  return `<!-- towercab:${step.toLowerCase()}:${round} -->`;
}

/** PIP-182: who wrote a comment (`agent`) and for which intent (`intent`, an issue number before it exists). */
export interface By {
  agent: string;
  intent: string;
}

/** PIP-182: the agent a stage's text comes from; steps no agent wrote are Towercab's own. */
const STAGE_AGENT: Record<string, string> = {
  design: "designer",
  plan: "planner",
  build: "builder",
  review: "reviewer",
  risk: "risk",
};

/**
 * PIP-182: the agent behind a `step` comment. A step an agent writes is named by it; a question or an
 * answer by the agent of `stage`, the stage of the mission that asks; the rest are Towercab's.
 */
export function agentOf(step: Step, stage = ""): string {
  const own = STAGE_AGENT[step.toLowerCase()];
  if (own) return own;
  if (step === "Question" || step === "Answer") return STAGE_AGENT[stage.split(":")[0] ?? ""] ?? "towercab";
  return step === "Intake" ? "scorer" : "towercab";
}

/**
 * The comment's whole text: marker, header, a blank line, `body`. The header names the agent and the
 * intent (PIP-182): `**Question** · designer · 261105-2152-9 · round 3`.
 */
export function stageComment(step: Step, round: number, body: string, by?: By): string {
  const who = by ? ` · ${by.agent}${by.intent ? ` · ${by.intent}` : ""}` : "";
  return `${stageMarker(step, round)}\n**${step}**${who} · round ${round}\n\n${body.trim()}\n`;
}

/** PIP-184: the hidden first line of a comment an agent wrote under the owner's login. */
export const AGENT_MARKER = /^<!-- towercab:agent:([A-Za-z0-9-]+) -->$/;
export const agentMarker = (agent: string) => `<!-- towercab:agent:${agent} -->`;

/** PIP-185: the agent named by the marker on the first line of `body`, or null. */
export function agentOfBody(body: string): string | null {
  const m = AGENT_MARKER.exec((body.split("\n", 1)[0] ?? "").trim());
  return m ? m[1]! : null;
}

/** PIP-185: the line a stage comment adds when an agent answered for the owner. */
export const answeredByLine = (agent: string) => `Answered by ${agent}, for the owner.`;

/**
 * Post the step's comment on PR `pr` of `repo` as the App, or edit the bot's comment that already
 * carries its marker. Returns whether it edited.
 */
export async function upsertStageComment(
  forge: Forge,
  repo: string,
  pr: number,
  step: Step,
  round: number,
  body: string,
  by?: By,
): Promise<{ edited: boolean }> {
  return forge.upsertPrComment(repo, pr, stageMarker(step, round), stageComment(step, round, body, by));
}

/** The `gh` side of `Forge.upsertPrComment` (`gh api repos/<r>/issues/<n>/comments`, PATCH). */
export async function upsertComment(
  gh: GitHub,
  repo: string,
  pr: number,
  marker: string,
  text: string,
): Promise<{ edited: boolean }> {
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
