// JIRA-3: which of the owner's repos a ticket belongs to, by its Jira project, component or label.

import type { JiraConfig } from "../config.ts";
import type { Ticket } from "./client.ts";

/** The one repo whose selectors match the ticket, or why none is chosen. Matching is exact, any case. */
export function repoFor(cfg: JiraConfig, t: Ticket): { repo: string } | { skip: string } {
  const project = t.project.toLowerCase();
  const components = t.components.map((c) => c.toLowerCase());
  const labels = t.labels.map((l) => l.toLowerCase());
  const hits: string[] = [];
  for (const [repo, selectors] of cfg.repos) {
    const hit = selectors.some(
      (s) =>
        (s.kind === "project" && s.value === project) ||
        (s.kind === "component" && components.includes(s.value)) ||
        (s.kind === "label" && labels.includes(s.value)),
    );
    if (hit) hits.push(repo);
  }
  if (hits.length === 1) return { repo: hits[0]! };
  if (hits.length === 0) return { skip: "no repo's selectors match it" };
  return { skip: `${hits.join(" and ")} both match it` };
}
