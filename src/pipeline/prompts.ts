// Prompt templates: the body of `agents/<name>.md` (`{{key}}`), with data fenced so it can't close its
// own fence.

import { type AgentName, loadAgent } from "../agents.ts";

/** What each agent's handler gives its prompt (PIP-73 checks the files against it). */
export const AGENT_VARS: Record<AgentName, string[]> = {
  design: ["intent", "earlier", "reserved"],
  plan: ["intent", "spec_ids", "checks", "e2e"],
  worker: ["plan", "intent", "spec_ids", "checks", "access"],
  repair: ["what", "details"],
  review: ["intent", "spec_ids", "plan", "review_md", "ci", "screenshots", "diff_cmd", "e2e"],
  risk: ["gate", "intent", "change", "context", "open_points"],
  score: ["issue", "product"],
  features: ["repo", "current", "listed"],
  shadow: ["earlier", "state", "results", "message"],
};

/** An agent's prompt filled with `vars`; an unknown `{{key}}` is a bug, a missing var an empty string. */
export function render(name: AgentName, vars: Record<string, string>, dir?: string): string {
  const text = loadAgent(name, dir).prompt;
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`bug: agents/${name}.md uses {{${key}}} but it wasn't given`);
    return vars[key]!;
  });
}

/** Data placed between `<tag>` and `</tag>`: any `</tag` inside it is escaped. */
export function fence(text: string, tag: string): string {
  return text.replaceAll(`</${tag}`, `&lt;/${tag}`);
}

/** The intent file as the worker sees it (with `## Answers`), fenced for `<intent>`. */
export function intentData(text: string): string {
  return fence(text.trim(), "intent");
}
